-- Migration: Notification Failure Isolation
-- Adds columns and supports 'dead' status for notification deliveries

ALTER TABLE notification_deliveries ADD COLUMN alert_sequence INTEGER NULL;
ALTER TABLE notification_deliveries ADD COLUMN failure_metadata TEXT NULL;

ALTER TABLE notification_deliveries RENAME TO notification_deliveries_old;

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  notification_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT NULL,
  next_attempt_at TEXT NULL,
  alert_sequence INTEGER NULL,
  failure_metadata TEXT NULL
);

INSERT INTO notification_deliveries (
  id, idempotency_key, notification_type, entity_id, status, attempt_count,
  last_error, created_at, updated_at, sent_at, next_attempt_at
)
SELECT
  id, idempotency_key, notification_type, entity_id,
  status, attempt_count, last_error, created_at, updated_at, sent_at, next_attempt_at
FROM notification_deliveries_old;

DROP TABLE notification_deliveries_old;

CREATE INDEX idx_notification_deliveries_retry ON notification_deliveries(status, next_attempt_at);
