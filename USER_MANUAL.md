# LightGrant User Manual

LightGrant is an internal service designed to manage, approve, and automatically revoke temporary GitHub team memberships (JIT access) safely and efficiently.
This manual provides guides for general users submitting access requests, approvers managing requests, and administrators maintaining policies and operations.

---

## 📖 Table of Contents
1. [General User Guide](#1-general-user-guide)
   - [Initial Authorization Flow (OAuth Sign-In)](#initial-authorization-flow-oauth-sign-in)
   - [How to Request Temporary Access](#how-to-request-temporary-access)
   - [Request Progress and Automated Expirations](#request-progress-and-automated-expirations)
2. [Approver Guide](#2-approver-guide)
   - [Approving and Denying Access Requests](#approving-and-denying-access-requests)
   - [Providing Denial Reasons](#providing-denial-reasons)
3. [Administrator & Operator Guide](#3-administrator--operator-guide)
   - [Configuring Auto-Approval Policies (SQL Examples)](#configuring-auto-approval-policies-sql-examples)
   - [Preexisting Membership Protection Mechanics](#preexisting-membership-protection-mechanics)
   - [Auto-Revocation Polling and Retry Schedules](#auto-revocation-polling-and-retry-schedules)
   - [Monitoring Audit Trails](#monitoring-audit-trails)
   - [Diagnostics Dashboard & Secure DB Export](#diagnostics-dashboard--secure-db-export)

---

## 1. General User Guide

### Initial Authorization Flow (OAuth Sign-In)
Before submiting access requests for the first time, users must link their Slack account with their GitHub account.

1. Type the `/lightgrant` or `/lightgrant link` slash command in any Slack message field and submit.
2. If your accounts are not linked yet, you will receive a direct message (DM) from the LightGrant bot:
   > 🔗 *GitHub Account Link Required*
   > To use LightGrant, you need to authorize and link your GitHub account. Please click the link below to get started.
   > [Authorize GitHub Identity](https://your-domain.com/auth/github/start?...)
3. Click the link, click authorize on GitHub, and you will see a success page confirming your accounts are linked. Future requests will proceed directly.

### How to Request Temporary Access
1. Type `/lightgrant` in any Slack channel and submit.
2. An interactive request modal will appear:
   - **Target GitHub Team**: Choose the team you need temporary membership in (e.g., `frontend-team`, `infrastructure`).
   - **Access Duration**: Select the required duration (e.g., `60 minutes`, `4 hours`, `12 hours`).
   - **Reason**: Provide a brief justification (e.g., `Deploying hotfix to production env`).
3. Click **Submit** to send your request.

### Request Progress and Automated Expirations
- **Auto-Approved Requests**:
  If the request matches configured policy rules (such as matching eligible requester teams or duration limits), it is immediately approved. You will receive a success DM confirming membership has been granted on GitHub.
- **Manual Review Requests**:
  If the request does not qualify for auto-approval, you will receive a DM stating that your request has been routed to approvers for review.
- **Automated Expiration**:
  Once your requested duration expires, the background scheduler automatically removes you from the GitHub team. You will receive a DM notification confirming "Your temporary access has expired and has been automatically revoked."

---

## 2. Approver Guide

### Approving and Denying Access Requests
When a request requires manual approval, a request card is posted in the designated **Approval Channel** (e.g., `#github-approvals`).

- **Details Displayed**: The card contains the requester's Slack name, GitHub login, target team, requested duration, and justification reason.
- **Approve**: 
  Clicking the **Approve** button immediately adds the user to the GitHub team. The Slack card will update to show "Approved by @approver_name".
- **Deny**: 
  Clicking the **Deny** button opens a modal requesting rejection details.

### Providing Denial Reasons
1. Click the **Deny** button on the approval card.
2. Enter the reason for rejection in the modal (e.g., `Duration is too long. Please submit a shorter request.`).
3. Click submit. The request will be marked as denied, and the requester will receive a DM containing your denial reason.

---

## 🛠️ Slack Slash Commands Reference

The primary interface for LightGrant is the `/lightgrant` slash command. Below is the reference of available subcommands:

### `/lightgrant` or `/lightgrant request`
- **Description**: Opens the interactive access request modal.
- **Permissions**: Linked Slack-GitHub users.
- **Inputs**: Target GitHub team slug, request duration, and justification reason.
- **Result**: Submits the request. Auto-approved if it matches active policies; otherwise routed to the manual approval channel.

### `/lightgrant link`
- **Description**: Starts the identity linkage flow (OAuth with GitHub).
- **Permissions**: All Slack users.
- **Result**: Binds the Slack identity to the GitHub identity.

### `/lightgrant unlink`
- **Description**: Unlinks your Slack account from GitHub.
- **Permissions**: Linked users.

### `/lightgrant policy`
- **Description**: Opens the Policy Management modal to create or update auto-approval policies.
- **Permissions**: **GitHub Team Maintainers** or **LightGrant Administrators**.
- **Inputs**: Target GitHub team, eligible requester GitHub teams, and maximum allowed duration.
- **Result**: Registers or updates the auto-approval rules.

### `/lightgrant status`
- **Description**: Check the status of your current temporary grants.
- **Permissions**: Linked users.

### `/lightgrant audit`
- **Description**: Generate and download audit logs (or query audit state).
- **Permissions**: **LightGrant Administrators** only.

### `/lightgrant help`
- **Description**: Displays the help menu with usage guidelines.
- **Permissions**: All users.

---

## 3. Administrator & Operator Guide

### Initial Setup Flow (循環依存の解消)
To bootstrap LightGrant for the first time, follow this setup sequence to avoid circular dependencies between application configuration and Slack/GitHub App registration:

1. **Create a Railway Project**: Deploy this repository as a single service on Railway. Generate a public domain (e.g., `https://lightgrant-production.up.railway.app`). The app does not need to boot successfully at this stage; we only need to secure the public domain.
2. **Generate Offline App Manifests**: Run the offline generator locally to compile your manifests with the public domain:
   ```bash
   npm install
   npm run generate:manifests -- --base-url https://<your-railway-domain>
   ```
   This generates `generated-manifests/slack-app.yaml` and `generated-manifests/github-app.json`.
3. **Create and Install Slack App**: Go to [Slack App Console](https://api.slack.com/apps), click **Create New App** -> **From an app manifest**, and paste the contents of `generated-manifests/slack-app.yaml`. Install the app to your workspace and retrieve the **Bot User OAuth Token** and **Signing Secret**.
4. **Create and Install GitHub App**: Go to your GitHub Organization settings -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**, and fill out the parameters from `generated-manifests/github-app.json`. Generate and download a **Private Key** (PEM format) and convert it to Base64. Install the app onto your GitHub Organization and retrieve the **App ID**, **Client ID**, **Client Secret**, and **Webhook Secret**.
5. **Configure Environment Variables**: Set all environment variables (refer to `.env.example` or README.md) on Railway.
6. **Configure Volume Mount**: Mount a persistent volume to `/data` in your Railway service settings.
7. **Deploy and Verify**: Start the app and verify that `/healthz`, `/readyz`, and `/setup` endpoints load.
8. **Invite Bot to Slack Channels**: Run `/invite @LightGrant` inside both your Approval Channel (`SLACK_APPROVAL_CHANNEL_ID`) and Audit Channel (`SLACK_AUDIT_CHANNEL_ID`). This step is mandatory because LightGrant does not request the broad `chat:write.public` scope.

### Slack Error Troubleshooting
- **`not_in_channel`**: The Slack Bot was not invited to the channel. Run `/invite @LightGrant` in the channel.
- **`channel_not_found`**: Confirm the channel ID configuration in environment variables, and make sure the bot has access.
- **`missing_scope`**: Reinstall the Slack App using the latest manifest to grant all required scopes.

---

### Configuring Auto-Approval Policies
Auto-approval policies are managed interactively through the Slack interface. Operators or maintainers do not need to run manual SQL inserts.
1. Run `/lightgrant policy` in Slack.
2. Select the target GitHub team to define policies for.
3. Configure the eligible source teams (requesters who are members of these teams will be auto-approved) and specify the maximum allowed duration.
4. Click submit to register the policy. The engine automatically creates cryptographically signed policy snapshot snapshots.

### Preexisting Membership Protection Mechanics
LightGrant handles cases where a user requests access to a team they already belong to (e.g., permanent members).
- **Evaluation**: Checked immediately prior to applying a grant (auto or manual approval).
- **Behavior**: 
  If the user is already a member, GitHub API additions are bypassed, and the record is stored in the `grants` table with `membership_created_by_app = 0` (status: `already_present`).
- **Expiration Protection**: 
  When the grant expires, the scheduler recognizes this flag and **bypasses the GitHub membership removal**. The user remains in the GitHub team undisturbed, preventing accidental lockouts.

### Auto-Revocation Polling and Retry Schedules
The auto-revocation scheduler runs at 1-minute intervals as a background polling task.
- **Retry Backoff Algorithm**:
  If the GitHub API fails due to temporary outages or rate limits, the grant status shifts to `revoke_failed` and the `attempt_count` is incremented.
  The next execution time (`next_revoke_attempt_at`) is scheduled using an exponential backoff sequence: 1 minute, 5 minutes, 15 minutes, and then 1 hour intervals.
  The scheduler continues to retry at 1-hour intervals to ensure eventual consistency and safety.

### Monitoring Audit Trails
All critical lifecycle actions are posted to the Slack channel configured as `SLACK_AUDIT_CHANNEL_ID` in real-time.

* Access Request Determinations:
  > 📄 **Access Request Audit Log** (ID: `req-xxx`)
  > - **User**: @slack_user (GitHub: @github_user)
  > - **Target Team**: `frontend-team`
  > - **Duration**: `60 minutes`
  > - **Status**: ✅ **Auto-Approved** (or **Manually Approved by @approver**, **Manually Denied by @approver**)

* Membership Expirations and Revocations:
  > 📄 **Membership Revocation Audit Log** (Grant ID: `grant-xxx`)
  > - **User**: @slack_user (GitHub: @github_user)
  > - **Target Team**: `frontend-team`
  > - **Status**: 🔏 **Automatically Revoked** (or ℹ️ **Revocation Skipped** (Preexisting protection), 🚨 **Revocation Failed**)

Operators can monitor this audit log to ensure compliance and track unexpected operational errors.

---

### Resilience & Hardening Operations

LightGrant is equipped with production-grade resilience and hardening features to protect against operational race conditions, API failures, and inconsistent states:

#### 1. Uncertain Grant Recovery
If the application crashes or restarts while a GitHub membership addition request is in-flight (in the `add_request_sent` state), LightGrant automatically performs self-healing. Upon restarting or executing the next worker cycle, it queries GitHub to check if the membership was successfully added:
- **If present**: The grant state is recovered as `active`, preventing double-addition and avoiding retry loop locks.
- **If absent**: Bypasses retry-related preexisting flags and securely retries the membership addition under a fresh transaction context.

#### 2. Reactivation & Revocation Race Condition Shield
To prevent lockout bugs when a new request is approved while the system is actively removing a user from the same team (state: `revoking` or `revoke_failed`):
- **Intent Check**: Immediately before calling the GitHub deletion API, LightGrant runs a double-check within a database transaction to verify if any new active access request has been approved.
- **Cancellation**: If a new approved request exists, the revocation is aborted, and the grant state is reset back to `active` (recording a `revoke.cancelled_due_to_new_request` audit event).

#### 3. Elevated Role Safe-Lock (Maintainer Protection & Drift Sync)
If a user is manually promoted to a `maintainer` on GitHub while their temporary grant is active (or if membership drift is detected via Webhooks):
- **Bypass Deletion**: Upon expiration, LightGrant detects the elevated role and aborts the automated deletion to prevent accidental lockout of project maintainers.
- **Recheck Scheduler**: The revocation attempt is deferred by **1 hour** (`next_revoke_attempt_at = now + 1 hour`), and the incident is logged (`grant.membership_elevated`).
- **Slack Alert Throttling**: Critical Slack alerts for maintainer elevation are throttled to once every 24 hours per user-team pair to avoid alert fatigue.
- **Drift Synchronization**: 
  - If the user is later demoted back to a standard `member` (or manual demotion/removal is detected via Webhook), LightGrant automatically synchronizes the state.
  - If a user is manually added directly on GitHub, LightGrant records an audit event (`github.external_membership_added`) and does not create a synthetic grant.
  - If a user is manually removed directly on GitHub, the active grant is marked as `revoked` and audit logs are recorded.
  - App-created memberships (`membership_created_by_app = true`) preserve their origin even if temporarily elevated to maintainers, ensuring they will be safely deleted when they return to standard members.

#### 4. IdP-Synchronized Team Protections
GitHub teams synchronized with an external Identity Provider (e.g., Entra ID, Okta) reject manual membership additions with a validation error (typically HTTP 422).
- **Error Normalization**: LightGrant safely parses the raw API error / documentation URL and translates it into a non-retryable `GitHubIdpSyncError`.
- **Permanent Failure**: The grant status transitions to `grant_failed` (`last_error_code = github_team_sync_managed`), halting retry loops.
- **Team Catalog Flag**: The team catalog record is marked with `synchronized_flag = 1`.
- **UI Guard & Submission Validation**: In Slack, synchronized teams are labeled with `(IdP managed — unsupported)` in dynamic select menus, and any request modal submission for these teams is rejected with a validation error response.

#### 5. Asynchronous Notification Queue
Slack notification dispatching is decoupled from the core state machine using dedicated background jobs (`notify_request_result` and `post_audit_notification`).
- **Isolation**: Transient Slack API outages will not block or trigger unnecessary retries of GitHub membership modifications.
- **Idempotency Check**: Uses a `notification_deliveries` database table to track dispatched messages, guaranteeing that users and audit channels do not receive duplicate notifications.

---

### Diagnostics Dashboard & Secure DB Export

LightGrant provides a built-in Diagnostics Dashboard for administrators to monitor the health of the application and export database backups securely.

#### 1. Access Protection (`SETUP_TOKEN`)
The setup and diagnostics endpoints under `/setup` (including the status page and the Slack app manifest generation endpoint `/setup/slack-manifest.yaml`) are protected by a secure Bearer token authentication middleware.
- To access the dashboard, administrators must provide the `SETUP_TOKEN` either as a Bearer authorization header or via the `setup_token` query parameter:
  ```
  https://your-app-domain.com/setup?setup_token=your-configured-setup-token
  ```
- Unauthorized access attempts will result in an immediate `401 Unauthorized` response.

#### 2. Lease-Based SQLite Database Backup Export & Download Leases
Administrators can download a snapshot of the active SQLite database directly from the dashboard:
- **Clicking the "Export Database Backup" button**: Sends a POST request to `/setup/export?setup_token=...` to generate a secure, single-use, 15-minute lease token.
- **SQLite Snapshot Backup**: Creates a WAL-consistent database snapshot using the `better-sqlite3` backup API, and validates it with `PRAGMA integrity_check` before serving.
- **Decoupled File Identity**: Decouples the download token from the file path by generating an independent UUID for the snapshot filename (e.g., `backup-[UUID].sqlite`), preventing token leakage via file paths.
- **One-Time Expiration & Concurrency Limit**: Enforces short-term leases (valid for 60 seconds of initial stream request) and blocks concurrent downloads using the same token. The token is marked as `used_at = now` ONLY when the download stream successfully finishes.
- **Fault-Tolerant Retries**: If the download is aborted or fails mid-way due to network issues, the lease is automatically released, allowing the administrator to retry the download within the 15-minute window.
- **Path Traversal Protection**: Enforces strict path validation restricting downloads to either the database path or the designated secure `/data/exports` directory.
- **Administrative Reprocessing**: Failed Webhook deliveries can be reprocessed in bulk or individually via the POST endpoint `/setup/webhooks/reprocess` (with optional `delivery_id` query parameter).
