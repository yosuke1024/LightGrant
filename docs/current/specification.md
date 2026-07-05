---
status: implemented
last_updated: 2026-07-03
---

> [!WARNING]
> Deprecated: This document is not authoritative.
> See README.md, USER_MANUAL.md, and docs/operations.md.

# LightGrant - System Specification

LightGrant is a lightweight, self-hosted JIT (Just-In-Time) access manager for GitHub Teams, controlled via Slack.

## Core System Architecture

### 1. Technology Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript (Strict Mode)
- **HTTP Framework:** Express (configured under `src/http/server.ts`)
- **Slack Framework:** Slack Bolt for JavaScript (ExpressReceiver Integration)
- **GitHub Framework:** Octokit
- **Database:** SQLite (better-sqlite3) running WAL, Foreign Keys, and 5000ms timeout
- **Logging:** Pino structured JSON logging (with token and secret redactions)
- **Testing:** Vitest

### 2. Implemented Components (Milestone 1)
- **Configuration (Zod):** Environment validation on startup rejecting placeholder values and decoding base64 PEM private keys.
- **Database Connection & Migration Runner:** Automatically loads and runs transactionally versioned SQL files from `/migrations` directory.
- **Liveness & Readiness checks:**
  - `/healthz`: process liveness
  - `/readyz`: readiness status verifying database, migrations run, and worker threads startup.
- **Graceful Shutdown:** Cleans up server socket, database connection, and logs before closing application.

### 3. Implemented Components (Milestone 2)
- **GitHub App Auth & Token Resolution:** Loads decoded PEM key, generates App JWT to authenticate with GitHub, resolves installation ID for the specified target organization, and retrieves temporary installation access tokens.
- **GitHub Access Provider:** `GitHubClient` implements `GitHubAccessProvider` using Octokit to list teams, check organization and team membership status, and add/remove users dynamically.
- **Team Catalog Caching:** `TeamRepository` manages local `github_teams` table in SQLite, providing case-insensitive searches, prefix prioritization, active-status filtering, and IdP synchronization status marking.
- **GitHub Domain Error Mapping:** Translates Octokit HTTP responses (e.g. rate limits, IdP-synchronized team write bans, 404 Not Found, 401 Unauthorized, and transient network timeouts) into type-safe custom domain exception models.

### 4. Implemented Components (Milestone 3)
- **Slack App Foundation:** Integrates Slack Bolt with `ExpressReceiver` mounted to `/slack/events` routing on Express.
- **Identity Link Mapping:** `IdentityRepository` persists and queries active ID mappings linking Slack Workspace/User to GitHub User details in SQLite.
- **Replay Protection State:** `OAuthStateRepository` records security nonces to enforce one-time usage on GitHub OAuth callbacks.
- **Signed State Tokens:** Cryptographically signed state tokens protect OAuth redirect parameters with timing-safe HMAC-SHA256 verification and expiration checks.
- **GitHub OAuth Flows:** `/auth/github/start` and `/auth/github/callback` exchange user authorization codes for temporary tokens to establish active identity link associations.
- **Dynamic Setup Manifests:** `/setup/slack-manifest.yaml` outputs a custom-configured Slack manifest including dynamically bound `PUBLIC_BASE_URL` routes.

### 5. Implemented Components (Milestone 4)
- **Manual Access Request Flow:** Users submit a Slack modal specifying dynamic GitHub teams (searched from local cache), duration, and reasons.
- **Manual Request Persistence:** `RequestRepository` persists incoming access requests in SQLite (`status = 'pending'`).
- **Slack Notification Routing:** `SlackNotifierService` formats and posts a Block Kit manual approval request message to the configured Slack approval channel containing Opaque request IDs only.
- **Approver Verification & Authorization:** Evaluates if the Slack user who clicked `[Approve]` has an active identity link and possesses team `maintainer` role or org owner (admin) permissions on GitHub via live client checks.
- **Replay & Overwrite Protection:** Restricts decisions to pending requests and locks database states upon resolution.
- **Preexisting Role Protection:** Protects preexisting GitHub team memberships by skipping App creation indicators (`membership_created_by_app = 0` and status `already_present`), shielding preexisting roles from automatic cleanups.
- **Denial Flow:** Interactive rejection modals record denied reasons and issue updates to Slack channel logs and requesters.

### 6. Implemented Components (Milestone 5)
- **Auto-Approval Policy Cache Schema:** Querying policies and policy versions in a single query via `PolicyRepository` mapped to SQLite tables.
- **Auto-Approval Rule Engine:** Rule engine (`policy-engine.ts`) to validate requesting duration and policy rules.
- **Immediate Grant Execution:** Instantaneous auto-approval execution routing that skips Slack manual notifications, directly adds GitHub team membership (incorporating preexisting membership protection), and records the granted state in SQLite.
- **Audit Ledger Dispatch:** Real-time generation of detailed audit trails posted to the configured Slack audit channel (`SLACK_AUDIT_CHANNEL_ID`) for both manual and auto-approved resolutions.

### 7. Implemented Components (Milestone 6)
- **Auto-Revocation Loop Scheduler:** Polling task (`AccessScheduler`) scanning expired grants in SQLite at 1-minute intervals.
- **Preexisting Role Protection (Revocation Bypass):** Safely skips GitHub membership deletion for preexisting members (`membership_created_by_app = 0`), updating state to `already_present` with `revoked_at` set.
- **GitHub Member Removal:** Calls `removeTeamMember` to automatically delete expired users from GitHub teams for app-granted memberships.
- **Resilient Retry Backoff:** Handles transient GitHub API errors by increments of `attempt_count` and scheduling exponential backoffs (`next_revoke_attempt_at`). Marks as permanently `failed` after maximum configured attempts.
- **Expiration Alerts & Logs:** Resolves expired grants, dispatches DM notifications (`notifyRevocation`), and posts audit events (`postAuditRevocation`) detailing skips, removals, and retry failures.

---

## Database Schema (Current SSOT)

Refer to `/migrations/0001_initial.sql` for the current table definitions. Major tables include:
- `identity_links`: Mapping between Slack User ID and GitHub User ID.
- `oauth_states`: For securely verifying GitHub user authentication flow.
- `policies` & `policy_versions`: Auto-approval policies owned by Team Maintainers.
- `access_requests` & `approvals`: Access requested by users and actions taken by approvers.
- `grants` & `grant_requests`: The active access state, expiration timing, and retry schedules.
- `jobs`: Durable transactional queues for evaluating requests, adding/removing members, caching, and exporting audit logs.
- `audit_events`: Append-only cryptographic SHA-256 hash chained event ledger.
- `webhook_deliveries`: Deduplication repository for incoming GitHub events.
- `export_tokens`: Used for downloading one-time signed CSV/JSONL audit exports.
- `github_teams`: Cache database representing organization structure.
