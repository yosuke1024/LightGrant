# Threat Model & Security Architecture

This document describes the threat model for LightGrant MVP. It analyzes potential security threats, evaluates their impact, and details the specific mitigations implemented in the system.

---

## 1. Threat Scenarios and Mitigations

### 1.1 Slack Bot Token Leak (Slack Bot Token漏洩)
- **Threat**: An attacker obtains the `SLACK_BOT_TOKEN`. This allows them to read messages, post alerts, and interact with users on behalf of the bot.
- **Impact**: High (Integrity/Confidentiality loss in Slack organization).
- **Mitigation**:
  - Tokens are never stored in the source code or database. They must be supplied strictly through environment variables.
  - The structured logging engine (`logger.ts`) is configured to mask credentials matching the Slack token patterns before writing to standard output.
  - Slack APIs are scoped with the **Principle of Least Privilege** (only requesting `commands` and `chat:write` scopes).

### 1.2 GitHub App Private Key Leak (GitHub App Private Key漏洩)
- **Threat**: An attacker obtains the `GITHUB_PRIVATE_KEY_BASE64` (PEM key). They can generate JWTs and act as the GitHub App, performing arbitrary mutations in the GitHub Organization.
- **Impact**: Critical (Unauthorized repository and organization access).
- **Mitigation**:
  - The private key is injected as a Base64-encoded environment variable (`GITHUB_PRIVATE_KEY_BASE64`) and decoded strictly in-memory during boot.
  - The logging system automatically scrubs strings matching standard PEM key boundaries.
  - GitHub App installations must restrict their permissions strictly to **Organization members: Read & Write** and **Repository contents: Read-Only** (or none, if team membership is the only required API access).

### 1.3 Forged Slack Request (Slack偽装リクエスト)
- **Threat**: An attacker bypasses Slack and sends forged HTTP payloads directly to the application's Slack receiver endpoints.
- **Impact**: High (Unauthorized access requests or policy updates).
- **Mitigation**:
  - **Slack Signature Verification**: Every incoming request from Slack must pass the standard signing verification flow using the `SLACK_SIGNING_SECRET`.
  - The `@slack/bolt` framework receiver automatically validates the `x-slack-signature` and `x-slack-request-timestamp` headers, rejecting requests that are replayed (skewed by >5 minutes) or contain mismatched signatures.

### 1.4 Forged GitHub Webhook (GitHub偽装Webhook)
- **Threat**: An attacker sends fake webhook payloads to `POST /webhooks/github` (e.g. claiming a team membership has been removed) to disrupt state synchronization.
- **Impact**: Medium (DoS on valid grants).
- **Mitigation**:
  - **HMAC-SHA256 Signature Verification**: The endpoint calculates the HMAC-SHA256 digest of the raw HTTP request body using `GITHUB_WEBHOOK_SECRET` and performs a constant-time comparison (`crypto.timingSafeEqual`) against the `x-hub-signature-256` header.

### 1.5 OAuth State Replay / CSRF (OAuth State Replay)
- **Threat**: An attacker intercepts an authorization link and replays the OAuth callback, or attempts to link their own Slack profile to a victim's GitHub profile.
- **Impact**: Medium (Identity mapping hijacking).
- **Mitigation**:
  - **Cryptographically Signed States**: The state parameter used in the GitHub OAuth redirect URL contains a JSON payload containing:
    1. A cryptographically signed token (using `APP_SECRET` and HMAC-SHA256).
    2. A single-use random `nonce`.
    3. The requester's Slack User ID.
  - The callback validation endpoint verifies the HMAC signature, confirms the Slack User ID matches the session, and enforces that the `nonce` has not been used before.

### 1.6 Slack User Impersonation (Slack Userなりすまし)
- **Threat**: An attacker spoofs their Slack User ID in payloads to trigger auto-approvals or approve their own requests.
- **Impact**: High (Unauthorized GitHub membership grants).
- **Mitigation**:
  - Inside the Bolt event loop, all user identifiers are extracted directly from the verified Slack payloads (authenticated via signature).
  - Crucially, authorization is never determined solely by the Slack identity. Any approval action triggers a **Live GitHub Permission Verification** of the decider's active identity, confirming they are a Maintainer of the target team or an Org Owner on GitHub.

### 1.7 Malicious Maintainer (悪意のあるメンテナ)
- **Threat**: A team Maintainer creates policies allowing overly long access windows or attempts to auto-approve unauthorized users.
- **Impact**: Medium (Privilege creep).
- **Mitigation**:
  - Policy parameters are restricted by system-wide configurations (`MAX_REQUEST_DURATION_MINUTES`).
  - All policy adjustments, creation, or disablement events are recorded deterministically in the cryptographic audit log.
  - The background `validate_policy_authority` worker periodically validates that policy owners maintain active Maintainer/Org Owner rights. If they lose this status, their policies are auto-disabled.

### 1.8 Railway Project Owner DB Modification (Railway等によるDB直接変更)
- **Threat**: An administrator with direct database shell access alters a request state to `approved` or modifies a grant expiration time to gain permanent access.
- **Impact**: High (Security integrity bypass).
- **Mitigation**:
  - **Cryptographic Hash Chain (Audit Trail)**: Every state change writes to the `audit_events` table.
  - Each entry is hashed (`SHA-256`) in sequence, binding the new entry to the `event_hash` of the previous entry. Mismatches are immediately flagged by `verifyChain()`.
  - Discrepancies between `grants` table statuses and the `audit_events` ledger are detectable, making DB tampering easily auditable.

### 1.9 Worker Downtime (Worker停止 / DoS)
- **Threat**: The background job worker or scheduler crashes, leaving expired access grants unrevoked on GitHub.
- **Impact**: Medium (Privilege accumulation during outage).
- **Mitigation**:
  - **Startup Reconciliation Sync**: On application bootstrap, the `ReconciliationService` immediately scans for all expired grants in the database and triggers revocation.
  - The system is designed to be stateless and resilient to crash-loop restarts.

### 1.10 GitHub API Partial Failure (GitHub APIの部分的障害)
- **Threat**: Rate limits, network partitions, or GitHub downtime cause membership additions or removals to fail.
- **Impact**: High (Revocation failure or JIT delay).
- **Mitigation**:
  - **Exponential Backoff Retries**: Failed revocations are retried up to 3 times at increasing intervals (1 min, 5 min, 15 min), and thereafter hourly.
  - **Alert Suppression**: To prevent alert fatigue while ensuring operator notice, admin alerts are dispatched strictly on the 1st failure, 3rd failure, and then once every 24 hours.

### 1.11 Approval and Grant TOCTOU (Time-of-Check to Time-of-Use)
- **Threat**: A request is approved, but before the background job adds the user to the GitHub team, the user is removed from the Slack workspace or their role changes.
- **Impact**: Medium (Unauthorized entitlement application).
- **Mitigation**:
  - **Durable State Validation**: The async JobWorker does not rely on cached payload assertions. When executing the `grant_access` job, it performs a **Live Org Membership Check** and **Live Role Validation** on GitHub immediately prior to invoking the membership addition mutation.

### 1.12 External Membership Elevation (GitHub上での直接の権限変更)
- **Threat**: A temporary member is elevated to a permanent `maintainer` role directly on GitHub. If the scheduler blindly revokes them, it may disrupt operational workflows.
- **Impact**: Medium (Accidental administrative lockout).
- **Mitigation**:
  - **Role Protection**: Prior to issuing a team removal API call, the `RevocationService` checks the user's current live role. If the role is elevated (e.g. `maintainer`), revocation is aborted, the status is marked `revoke_failed`, the error code `membership_elevated` is logged, and an operator alert is dispatched.

### 1.13 Secret Logging (ログへの機密情報の出力)
- **Threat**: Diagnostic logging accidentally prints OAuth tokens, raw private keys, or Webhook secrets to console logs.
- **Impact**: Medium (Information disclosure via log aggregators).
- **Mitigation**:
  - Structured logs using `pino` are passed through a custom serializer that scrubs keys matching `token`, `secret`, `privateKey`, or `key`.
