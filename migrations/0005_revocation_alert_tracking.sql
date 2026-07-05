-- Migration: Revocation Alert Tracking
-- Adds columns and indexes to grants table for advanced revocation alert suppression.

ALTER TABLE grants ADD COLUMN last_revoke_alert_at TEXT NULL;
ALTER TABLE grants ADD COLUMN last_revoke_alert_reason TEXT NULL;

CREATE INDEX idx_grants_revoke_retry ON grants(status, next_revoke_attempt_at);
