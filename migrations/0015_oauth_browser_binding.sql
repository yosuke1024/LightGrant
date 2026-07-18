-- Migration: OAuth Browser Binding (Sign in with Slack)
-- Closes an account-takeover hole in GitHub account linking.
--
-- Before this change the GitHub OAuth callback trusted the Slack identity
-- recorded in the signed state alone. An attacker could generate a connect
-- URL for their own Slack user, forward it to a victim, and have the victim
-- complete GitHub OAuth in their own browser — binding the victim's GitHub
-- account to the attacker's Slack user. Neither the signed state nor a cookie
-- issued at /auth/github/start defends against this, because the victim opens
-- the forwarded URL from the very start.
--
-- The fix inserts a Sign in with Slack (OIDC) leg between start and GitHub,
-- and binds the OIDC-verified browser to the GitHub callback with a one-time
-- cookie. These columns hold the per-flow state for that binding:
--
--   * oidc_nonce_hash    — sha256 of the OIDC nonce sent to Slack's authorize
--     endpoint; re-checked against the id_token `nonce` claim to fence replay
--     of a captured Slack authorization code.
--   * slack_verified_at  — set once Slack OIDC confirmed the browser user is
--     the SAME slack_user_id / slack_workspace_id recorded on this row. The
--     GitHub callback refuses to link unless this is set.
--   * binding_token_hash — sha256 of the one-time browser-binding cookie value
--     issued after Slack verification. The GitHub callback links only if the
--     presented cookie hashes to this value, so a browser that never passed
--     Slack verification for THIS flow cannot complete the link. Cleared when
--     the state is consumed.

ALTER TABLE oauth_states ADD COLUMN oidc_nonce_hash TEXT NULL;
ALTER TABLE oauth_states ADD COLUMN slack_verified_at TEXT NULL;
ALTER TABLE oauth_states ADD COLUMN binding_token_hash TEXT NULL;
