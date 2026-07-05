-- Migration: Export File Identity
-- Adds file_id column to decouple raw tokens from file paths.

ALTER TABLE export_tokens ADD COLUMN file_id TEXT NULL;
