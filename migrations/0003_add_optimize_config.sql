-- Add optimize_config column for per-bucket image optimization settings
-- JSON format: {"enabled":true,"format":"auto","quality":80,"maxWidth":2048}
ALTER TABLE buckets ADD COLUMN optimize_config TEXT;
