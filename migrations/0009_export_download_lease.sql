-- Migration: Export Download Lease
-- Adds columns to track lease-based downloading of audit exports to prevent token leakage and allow retry.

ALTER TABLE export_tokens ADD COLUMN download_started_at TEXT NULL;
ALTER TABLE export_tokens ADD COLUMN download_lease_expires_at TEXT NULL;
