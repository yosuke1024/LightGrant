-- Migration: Grant Mutation Tracking
-- Adds columns and indexes to grants table to track GitHub mutation intents.

ALTER TABLE grants ADD COLUMN membership_mutation_state TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE grants ADD COLUMN membership_add_attempted_at TEXT NULL;
ALTER TABLE grants ADD COLUMN membership_add_operation_id TEXT NULL;
ALTER TABLE grants ADD COLUMN membership_add_last_verified_at TEXT NULL;

CREATE INDEX idx_grants_mutation_state ON grants(membership_mutation_state, status);
CREATE INDEX idx_grants_org_user_team ON grants(github_org_id, github_user_id, target_team_id);
