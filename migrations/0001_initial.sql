-- Initial migration schema for LightGrant MVP

-- 1. Identity Links Table
CREATE TABLE identity_links (
  id TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  unlinked_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_identity_links_slack ON identity_links(slack_workspace_id, slack_user_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX idx_identity_links_github ON identity_links(slack_workspace_id, github_user_id) WHERE unlinked_at IS NULL;

-- 2. OAuth States Table
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  slack_workspace_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  resume_action_type TEXT NULL,
  resume_action_id TEXT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);

-- 3. Policies Table
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  github_org_id INTEGER NOT NULL,
  target_team_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_by_identity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT NULL,
  disabled_reason TEXT NULL,
  FOREIGN KEY(created_by_identity_id) REFERENCES identity_links(id)
);

-- 4. Policy Versions Table
CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  effect TEXT NOT NULL,
  requester_team_ids_json TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL,
  reason_required INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_by_identity_id TEXT NOT NULL,
  authority_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(policy_id, version),
  FOREIGN KEY(policy_id) REFERENCES policies(id),
  FOREIGN KEY(created_by_identity_id) REFERENCES identity_links(id)
);

-- 5. Access Requests Table
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  github_org_id INTEGER NOT NULL,
  requester_identity_id TEXT NOT NULL,
  target_team_id INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decision_status TEXT NOT NULL,
  decision_mode TEXT NULL,
  matched_policy_id TEXT NULL,
  matched_policy_version INTEGER NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT NULL,
  denied_reason TEXT NULL,
  slack_approval_channel_id TEXT NULL,
  slack_approval_message_ts TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(requester_identity_id) REFERENCES identity_links(id),
  FOREIGN KEY(matched_policy_id) REFERENCES policies(id)
);

-- 6. Approvals Table
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  access_request_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  approver_identity_id TEXT NOT NULL,
  approver_github_user_id INTEGER NOT NULL,
  authority_role TEXT NOT NULL,
  authority_verified_at TEXT NOT NULL,
  reason TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(access_request_id) REFERENCES access_requests(id),
  FOREIGN KEY(approver_identity_id) REFERENCES identity_links(id)
);

-- 7. Grants Table
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  github_org_id INTEGER NOT NULL,
  target_team_id INTEGER NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  membership_created_by_app INTEGER NOT NULL,
  preexisting_role TEXT NULL,
  granted_at TEXT NULL,
  effective_expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  revoke_attempt_count INTEGER NOT NULL DEFAULT 0,
  next_revoke_attempt_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. Grant Requests Table
CREATE TABLE grant_requests (
  grant_id TEXT NOT NULL,
  access_request_id TEXT NOT NULL,
  requested_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(grant_id, access_request_id),
  FOREIGN KEY(grant_id) REFERENCES grants(id),
  FOREIGN KEY(access_request_id) REFERENCES access_requests(id)
);

-- 9. Durable Jobs Table
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  locked_at TEXT NULL,
  locked_by TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NULL
);

-- 10. Audit Events Table
CREATE TABLE audit_events (
  sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  slack_workspace_id TEXT NULL,
  slack_user_id TEXT NULL,
  github_org_id INTEGER NULL,
  github_user_id INTEGER NULL,
  github_team_id INTEGER NULL,
  access_request_id TEXT NULL,
  grant_id TEXT NULL,
  policy_id TEXT NULL,
  policy_version INTEGER NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 11. Webhook Deliveries Table
CREATE TABLE webhook_deliveries (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT NULL,
  status TEXT NOT NULL,
  last_error TEXT NULL,
  PRIMARY KEY(provider, delivery_id)
);

-- 12. Export Tokens Table
CREATE TABLE export_tokens (
  token_hash TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);

-- 13. GitHub Teams Catalog Table
CREATE TABLE github_teams (
  github_team_id INTEGER PRIMARY KEY,
  github_org_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  privacy TEXT NOT NULL,
  parent_team_id INTEGER NULL,
  synchronized_flag INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at TEXT NOT NULL,
  active_flag INTEGER NOT NULL DEFAULT 1
);
