-- Add default_encryption column for per-bucket SSE-S3 auto-encryption
ALTER TABLE buckets ADD COLUMN default_encryption INTEGER NOT NULL DEFAULT 0;
