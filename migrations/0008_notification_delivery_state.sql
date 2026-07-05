-- Migration: Notification Delivery State Machine
-- Updates notification_deliveries schema to support Compare-and-Set and retries.

-- 1. Rename existing table
ALTER TABLE notification_deliveries RENAME TO notification_deliveries_old;

-- 2. Create new table with state machine columns
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  notification_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT NULL,
  next_attempt_at TEXT NULL
);

-- 3. Migrate existing sent deliveries
-- Old table had delivery_key and sent_at. We map them into new schema.
INSERT INTO notification_deliveries (
  id,
  idempotency_key,
  notification_type,
  entity_id,
  status,
  attempt_count,
  created_at,
  updated_at,
  sent_at
)
SELECT
  delivery_key,
  delivery_key,
  'request_result',
  delivery_key,
  'sent',
  0,
  sent_at,
  sent_at,
  sent_at
FROM notification_deliveries_old;

-- 4. Drop the old table
DROP TABLE notification_deliveries_old;

-- 5. Create index for polling retries
CREATE INDEX idx_notification_deliveries_retry
ON notification_deliveries(status, next_attempt_at);
