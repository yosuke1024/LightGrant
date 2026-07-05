# Operations & Deployment Guide

This guide describes how to deploy, configure, and maintain LightGrant in a production environment (specifically hosting on platforms like Railway).

---

## 1. Deployment Architecture

LightGrant is built as a single-container application that houses:
- The Express HTTP server (handling GitHub OAuth callbacks, Webhooks, and Diagnostics `/setup`).
- The Bolt Slack receiver.
- The background `JobWorker` polling thread.
- A local SQLite database (`DATABASE_PATH`).

### Railway Deployment (1 Service + 1 Volume)
To prevent data loss during container redeployments and ensure database backups function correctly, you must attach a persistent volume to the application:

1. **Create a Service**: Deploy the container using the provided `Dockerfile`.
2. **Create Database Volume**: Provision a single Railway Volume (e.g., `1 GB`) mounted at `/data`. Configure the environment variable `DATABASE_PATH=/data/lightgrant.sqlite`.
3. **Backup Export Directory**: Database backups are generated inside `/data/exports` which is located within the same mounted volume.

---

## 2. Configuration Settings (Environment Variables)

Ensure the following variables are defined in your deployment configuration:

| Variable | Description | Required | Example |
|---|---|---|---|
| `PORT` | HTTP port the server listens on | Yes | `3000` |
| `PUBLIC_BASE_URL` | Canonical URL of your app | Yes | `https://lightgrant.railway.app` |
| `APP_SECRET` | 32+ character random string for OAuth state signatures | Yes | `d4e5f6... (at least 32 chars)` |
| `DATABASE_PATH` | Absolute path to the SQLite DB file | Yes | `/data/lightgrant.sqlite` |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth Token | Yes | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Yes | `ab12...` |
| `SLACK_APPROVAL_CHANNEL_ID` | Slack channel ID for manual approvals | Yes | `C01234567` |
| `SLACK_AUDIT_CHANNEL_ID` | Slack channel ID for system audit logs | Yes | `C09876543` |
| `GITHUB_APP_ID` | GitHub App ID | Yes | `123456` |
| `GITHUB_CLIENT_ID` | GitHub App Client ID | Yes | `Iv1.123...` |
| `GITHUB_CLIENT_SECRET` | GitHub App Client Secret | Yes | `sec_abc123...` |
| `GITHUB_PRIVATE_KEY_BASE64`| Base64 encoded PEM private key | Yes | `LS0tLS1...` |
| `GITHUB_ORG` | Targeted GitHub Organization name | Yes | `my-org-slug` |
| `GITHUB_WEBHOOK_SECRET` | Secret token configured for GitHub Webhooks | Yes | `super-secret-webhook-key` |

---

## 3. Operational Verification

Once deployed, you should verify system health via the built-in HTTP diagnostic endpoints.

### 3.1 Initial Setup Diagnostics
Navigate to `https://<your-app-domain>/setup` in your browser. This dashboard will verify:
- Database read/write connectivity.
- Correct loading and formatting of Slack tokens.
- Correct format and loading of GitHub integration credentials.
- Cryptographic integrity of the Audit Log hash chain.

### 3.2 Health Checks
- **Health check**: `GET /healthz` returns `200 OK` if the app is booted.
- **Readiness check**: `GET /readyz` checks if the database connection is alive and migrations have successfully run.

### 3.3 Startup Auto-Repair & Org ID Resolution
On startup, LightGrant automatically fetches the actual GitHub Organization ID from the GitHub API using `resolveInstallation`. 
If any database records (in `grants`, `policies`, `access_requests`, or `audit_events` tables) contain a placeholder `github_org_id = 0`, the system automatically runs an update transaction to overwrite those values with the actual resolved Organization ID. 

Operators should monitor startup logs to ensure this self-healing process executes successfully:
```json
{"level":"info","msg":"Resolved live GitHub Organization ID from installation","targetOrgId":12345}
{"level":"info","msg":"Repaired historical grants records with 0 github_org_id","table":"grants","count":3,"targetOrgId":12345}
```

---

## 4. Webhook Reprocessing & Recovery

If GitHub Webhook events fail to process due to transient issues (e.g. temporary API outages, database locks, or server restarts), administrators can reprocess them manually.

### 4.1 Reprocessing All Failed Webhooks
Submit an authenticated POST request to `/setup/webhooks/reprocess` with no query parameters:
```bash
curl -X POST "https://<your-app-domain>/setup/webhooks/reprocess?setup_token=<your-setup-token>"
```
This scans the `webhook_deliveries` table for all records with `failed` status and reprocesses them sequentially under lock protection.

### 4.2 Reprocessing a Specific Webhook
To reprocess a single delivery, include the `delivery_id` in the query parameters:
```bash
curl -X POST "https://<your-app-domain>/setup/webhooks/reprocess?setup_token=<your-setup-token>&delivery_id=<delivery-id>"
```

---

## 5. Database Backup & Verification

LightGrant supports exporting consistent SQLite database snapshots via the admin dashboard:
1. **Creation**: The export triggers a WAL-consistent snapshot backup using `better-sqlite3` backup APIs, preventing half-written states.
2. **Verification**: LightGrant runs `PRAGMA integrity_check` on the generated backup file immediately. The download is permitted only if the validation returns `ok`.
3. **Download Lease**: Downloads are protected via lease tokens:
   - Tokens have a 15-minute expiration time.
   - Concurrent downloads using the same token are blocked.
   - The token is marked as used and deleted only after the download stream successfully completes. If the network drops mid-way, the lease is released so administrators can retry downloading.
