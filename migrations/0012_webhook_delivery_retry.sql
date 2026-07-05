-- Migration: Webhook Delivery Retry Columns
-- Adds retry_count and next_attempt_at columns to webhook_deliveries table.

ALTER TABLE webhook_deliveries ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at TEXT NULL;
ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT NULL;
