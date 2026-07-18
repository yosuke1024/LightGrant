# Security Specifications

This document outlines the security architecture and validation controls implemented within the LightGrant MVP application.

---

## 1. Input Validation & Sanitization

All input fields originating from untrusted sources (Slack UI, GitHub Webhooks, OAuth Callbacks) are validated using strict Zod schemas.

- **Slack Actions**: Input payloads parsed by the Bolt framework are checked for structural validity. Team IDs, user IDs, and durations are validated to prevent injection or parameter tempering.
- **Duration Limits**: Requests for temporary access durations are bound by:
  - System-wide maximum: `MAX_REQUEST_DURATION_MINUTES` (configured via env).
  - Policy-specific maximum: Each policy defines a `max_duration_minutes` which is verified at request submission.
- **SQL Injection Prevention**: SQLite queries are structured using parameterized inputs (`better-sqlite3` prepared statements), ensuring untrusted inputs are never interpolated directly into SQL syntax.

---

## 2. Authentication & Cryptography

- **Timing Attack Mitigation**: When validating Webhook signatures, a constant-time comparison helper (`crypto.timingSafeEqual`) is used to compare calculated digests against received headers.
- **Anti-CSRF (State Parameter)**: OAuth state parameters are cryptographically signed with HMAC-SHA256 using `APP_SECRET` and contain short-lived random nonces.
- **Browser Identity Binding (Sign in with Slack)**: GitHub account linking first requires the browser to complete "Sign in with Slack" (OpenID Connect). The Slack callback verifies that the OIDC-authenticated `team_id`/`user_id` match the Slack identity recorded in the signed state, then issues a one-time `HttpOnly`/`SameSite=Lax` browser-binding cookie. The GitHub callback links accounts only if that cookie hashes to the value stored for the flow, preventing a forwarded connect link from binding a victim's GitHub account to the attacker's Slack user. The OIDC `id_token` is trusted per OpenID Connect Core §3.1.3.7 (received directly over the server-to-server TLS token exchange) with `iss`/`aud`/`exp`/`nonce` validated.
- **Secure Random Generation**: Cryptographic nonces and tokens (such as download links) are generated using securely-seeded pseudo-random generators (`crypto.randomBytes`).

---

## 3. Authorization (Live Privilege Checking)

LightGrant enforces dynamic, real-time privilege checks instead of relying on cached Slack entitlements:

1. **JIT Request**: Checks that the requester is an active member of the target GitHub organization.
2. **Approval/Denial**: Checks that the approver is a Maintainer of the target GitHub team or an Organization Owner.
3. **Policy updates**: Checks that the policy creator has Maintainer/Owner status on GitHub.
4. **Audit Export**: Accessing `/lightgrant audit` or downloading CSVs is restricted to Slack Workspace Admins or users who are Maintainers of the team.

---

## 4. Dependency Vulnerability Management (npm audit)

LightGrant maintains a dependency audit process to track and manage vulnerabilities. 

### Current Status (as of Release Candidate Hardening)
- **Vulnerabilities**: 5 vulnerabilities related to `esbuild` and `vite` packages.
- **Severity**: 2 moderate, 1 high, 2 critical.
- **Classification**: All flagged vulnerabilities exist strictly within `devDependencies` (Vite, Vitest, esbuild) used for local development, compilation, and testing.

### Mitigation Plan
1. **Production Isolation**: The production Docker image (`Dockerfile`) is built using a multi-stage approach and executes only runtime dependencies (`dependencies` only, skipping `devDependencies` by using `npm prune --production` or omitting dev dependencies). Thus, the vulnerable development packages are not deployed or run in the production container environment.
2. **Scheduled Upgrades**: Upgrading development packages (e.g., forcing major Vitest upgrades via `npm audit fix --force`) is scheduled for the next major release window to prevent breaking changes in the test runner.
