-- Migration: Security Hardening & Job Indexes
-- Adds unique index for active grants and helper indexes for jobs and grants

-- 1. Prevent duplicate active/pending grants for same Org-Team-User
CREATE UNIQUE INDEX idx_grants_one_managed_membership
ON grants(github_org_id, target_team_id, github_user_id)
WHERE status IN ('pending', 'active', 'revoking', 'revoke_failed');

-- 2. Indexes for efficient expiration checks and revocation
CREATE INDEX idx_grants_due_revoke
ON grants(status, effective_expires_at, next_revoke_attempt_at);

CREATE INDEX idx_grant_requests_expiration
ON grant_requests(grant_id, requested_expires_at);

-- 3. Indexes for Job worker polling and recovery
CREATE INDEX idx_jobs_runnable
ON jobs(status, run_after);

CREATE INDEX idx_jobs_locked
ON jobs(status, locked_at);
