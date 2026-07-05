-- Migration: Webhook Processing Lease Columns
-- Adds lease tracking columns and recovery index to webhook_deliveries table.

ALTER TABLE webhook_deliveries ADD COLUMN processing_started_at TEXT NULL;
ALTER TABLE webhook_deliveries ADD COLUMN lease_expires_at TEXT NULL;
ALTER TABLE webhook_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_webhook_deliveries_recoverable ON webhook_deliveries(status, lease_expires_at);
