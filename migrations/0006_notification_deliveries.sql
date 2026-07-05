-- Migration to create notification_deliveries table for notification idempotency
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
