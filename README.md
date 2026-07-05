# LightGrant

> [!WARNING]
> **Work In Progress (WIP)**: This project is currently in the testing and development phase. It is not recommended for production environments. Breaking changes may occur frequently.

LightGrant is a **Just-In-Time (JIT) temporary access manager** for GitHub team memberships.
Through Slack commands, users can request temporary access to specific GitHub teams. Depending on pre-configured policies, requests are either auto-approved or routed to a manual approval channel, with an automated scheduler handling revocation once the granted duration expires.

---

## 🚀 Key Features
1. **GitHub to Slack Identity Linkage (OAuth Flow)**
   - Sends a secure sign-in link via DM to users upon their first request to link Slack and GitHub identities (utilizing single-use nonces and signed state tokens to protect against replay attacks).
2. **Slack-Driven JIT Access Requests (`/lightgrant`)**
   - Triggers an interactive modal allowing users to select target GitHub teams, request durations (e.g., 30 mins to 24 hours), and document justification.
3. **Auto-Approval Policy & Rule Engine**
   - Automatically approves requests that match defined policy rules (e.g., requests from authorized users based on their GitHub Team membership within permitted durations).
4. **Manual Approver Workflows**
   - Routes requests that fail auto-approval to a designated approval channel. Approvers can approve or deny requests directly within Slack (including entering denial reasons in a modal).
5. **Preexisting Membership Protection**
   - Detects if a requester is already a member of the target team. If so, skips redundant GitHub API membership creations, marks the record as `membership_created_by_app = 0` (status: `already_present`), and **excludes them from automated revocation** to prevent accidental removal of permanent members.
6. **Auto-Revocation Scheduler & Resilience**
   - Runs a background polling loop (1-minute intervals) to identify expired access grants and automatically remove members from GitHub teams.
   - Handles transient GitHub API errors with an exponential retry backoff (1m, 5m, 15m, and then 1h intervals).
7. **Secure Webhook Reprocessing & Drift Sync**
   - Saves Webhook deliveries in DB with payload for retry. Failed deliveries can be reprocessed via the admin dashboard `/setup`.
   - Automatically detects membership drift via Webhooks. Direct removals, elevations to maintainer, and demotions to member are reconciled, while external manual additions are audited (no synthetic grant is created).
8. **Secure Download Leases & SQLite Snapshot Backups**
   - Utilizes `better-sqlite3` backup API to create WAL-consistent database snapshots verified via `PRAGMA integrity_check` before downloading.
   - Restricts concurrent downloads on the same token and enforces short-term leases (valid only until download finishes, releases on failure/abort).
9. **Comprehensive Audit Logs (Audit Trail)**
   - Posts real-time status updates (approvals, denials, auto-approvals, revocation successes, skips, and failed retries) to a configured `SLACK_AUDIT_CHANNEL_ID`.

---

## 🛠️ Technology Stack
- **Runtime**: Node.js (v22+) & TypeScript
- **Framework**: Express (for OAuth redirection routes and HTTP health checks)
- **Slack Integration**: `@slack/bolt` (Slack Webhook, Event, Command, and Interactive Component handling)
- **Database**: SQLite (via `better-sqlite3` with strict foreign key constraints enabled)
- **Testing**: Vitest (featuring integration and unit testing powered by isolated test DBs)
- **Formatter**: Prettier
- **Logger**: Pino (with sensitive data masking)

---

## ⚙️ Setup and Configuration

### Initial Setup Flow (循環依存の解消)
To boot up LightGrant for the first time, follow this setup sequence to avoid circular dependencies between the application configuration and Slack/GitHub App registration:

#### Step 1: Create a Railway Project
1. Deploy this repository as a single service on Railway.
2. Generate/publish a public domain (e.g., `https://lightgrant-production.up.railway.app`).
3. *Note*: The application does not need to start up successfully at this stage; we only need to secure the public domain.

#### Step 2: Generate Offline App Manifests
Run the offline generator locally to compile your manifests with the public domain:
```bash
npm install
npm run generate:manifests -- --base-url https://<your-railway-domain>
```
This generates:
- `generated-manifests/slack-app.yaml`
- `generated-manifests/github-app.json`

#### Step 3: Create and Install Slack App
1. Go to [Slack App Console](https://api.slack.com/apps) and click **Create New App** -> **From an app manifest**.
2. Copy and paste the contents of `generated-manifests/slack-app.yaml`.
3. Install the app to your workspace.
4. Retrieve the **Bot User OAuth Token** (`xoxb-...`) and **Signing Secret**.

#### Step 4: Create and Install GitHub App
1. Go to your GitHub Organization settings -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**.
2. Complete the form using the parameters from `generated-manifests/github-app.json`.
3. Generate and download a **Private Key** (PEM format). Convert it to Base64.
4. Install the app onto your GitHub Organization.
5. Retrieve the **App ID**, **Client ID**, **Client Secret**, and **Webhook Secret**.

#### Step 5: Configure Environment Variables
Configure the environment variables (refer to `.env.example` or the list below) on Railway.

#### Step 6: Configure Volume Mount
Mount a persistent volume to `/data` in your Railway service settings.

#### Step 7: Deploy and Verify
Verify that the application successfully starts. Check:
- `/healthz`
- `/readyz`
- `/setup` (Setup Dashboard)

#### Step 8: Invite Bot to Slack Channels
Because LightGrant does not request the broad `chat:write.public` scope, you must manually invite the bot user to the configured channels:
- Approval Channel (`SLACK_APPROVAL_CHANNEL_ID`)
- Audit Channel (`SLACK_AUDIT_CHANNEL_ID`)

Run `/invite @LightGrant` inside both channels.

---

### Slack Error Troubleshooting
If you encounter issues during Slack interactions, check the following common errors:
- **`not_in_channel`**:
  - The Slack Bot was not invited to the channel. Run `/invite @LightGrant` in the channel.
- **`channel_not_found`**:
  - Confirm the channel ID configuration in your environment variables, and make sure the bot has access to it.
- **`missing_scope`**:
  - Reinstall the Slack App using the latest manifest to grant all required scopes.

---

### 1. Environment Variables
Create a `.env` file in the root directory and define the following variables:

```env
# Server Configurations
PORT=3000
NODE_ENV=development
PUBLIC_BASE_URL=https://your-app-domain.com
APP_SECRET=your-super-secure-32-char-app-secret
SETUP_TOKEN=your-super-secure-setup-dashboard-token # Token protecting the /setup dashboard (must be at least 32 characters long)

# Database Configurations
DATABASE_PATH=/data/lightgrant.sqlite

# Slack Configurations
SLACK_SIGNING_SECRET=your-slack-signing-secret
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_APPROVAL_CHANNEL_ID=C12345678      # Channel to post manual approval request cards
SLACK_AUDIT_CHANNEL_ID=C87654321         # Channel to post audit logs

# GitHub App Configurations
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tL... # Base64-encoded private key
GITHUB_CLIENT_ID=Iv1.your-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_ORG=your-github-org
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret
```

---

## 🏃 Commands and Local Execution

### Install Dependencies
```bash
npm install
```

### Run Local Development Server (Hot Reload Enabled)
```bash
npm run dev
```

### Production Build and Execution
```bash
# Build TypeScript
npm run build

# Start Production Server
npm run start
```

### Code Formatting
```bash
npm run format
```

### Run Tests (Vitest)
```bash
# Run all tests
npm run test

# Run tests with coverage reports
npm run test:coverage
```

---

## 📂 Directory Structure
```
├── docs/                     # Specifications and manuals
├── src/
│   ├── config.ts             # Configuration parsing and schema validation (Zod)
│   ├── logger.ts             # Masked structured logger
│   ├── main.ts               # Application entrypoint & graceful shutdown handling
│   ├── domain/               # Core business domains, error classes, and policy evaluation
│   ├── http/                 # Express routers (OAuth endpoints and health checks)
│   ├── integrations/         # Slack Bolt and GitHub REST clients
│   ├── persistence/          # Database connection pool, migrations, and repository layers
│   └── services/             # Background scheduler and notification services
└── tests/                    # Vitest unit and integration test specs
```

For detailed user guides and operational workflows, please refer to the [User Manual (USER_MANUAL.md)](./USER_MANUAL.md).

---

## 🌐 Value Proposition & Operational Guide

### Railway Deployment & Volume Mount
Deploy as a single service on Railway. Ensure a persistent volume is mounted at `/data`.
- **Database Path**: `/data/lightgrant.sqlite`
- **Backup Exports**: `/data/exports`

### Backup & Restore
- **Backup**: Run a POST request to `/setup/export` with your `SETUP_TOKEN` to generate a single-use lease-based SQLite snapshot backup.
- **Restore**: Stop the service, copy the backup `.sqlite` file to `/data/lightgrant.sqlite`, and restart.

### Audit Model
The SQLite database stores the **SSOT cryptographically signed Audit Ledger**. The Slack Audit Channel is purely for real-time operator notifications and warnings, not the official ledger.

### Security & Limitations
- **IdP-Sync Teams**: LightGrant cannot write to GitHub teams synchronized with external Identity Providers (IdP). If an IdP-sync team is detected, the grant will fail and mark the team synchronized.
- **Single Workspace**: Supports single Slack workspace and single GitHub organization.
- **Setup Security**: The `/setup` dashboard endpoints are protected by `SETUP_TOKEN` which must be at least 32 characters long.
- **Alpha Release Limitations**: v0.1.0-alpha has been validated with single-operator smoke testing. Multi-user requester/approver workflows require pilot validation.
