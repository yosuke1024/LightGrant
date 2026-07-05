-- Migration: Safe Revocation & Alert Suppression
-- Adds alert tracking columns to grants table for suppression logic

ALTER TABLE grants ADD COLUMN last_alerted_at TEXT NULL;
ALTER TABLE grants ADD COLUMN alert_attempt_count INTEGER NOT NULL DEFAULT 0;
