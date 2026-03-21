-- User subscriptions for Telegram Stars payment tiers
CREATE TABLE IF NOT EXISTS user_subscriptions (
    user_id         TEXT    PRIMARY KEY,     -- Telegram user ID
    tier            TEXT    NOT NULL DEFAULT 'free',  -- 'free' or 'pro'
    starts_at       TEXT    NOT NULL,
    expires_at      TEXT,                    -- NULL for free tier
    stars_paid      INTEGER NOT NULL DEFAULT 0,
    payment_id      TEXT,                    -- Telegram payment charge_id
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON user_subscriptions (expires_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON user_subscriptions (tier);

-- Map buckets to their owning Telegram user
ALTER TABLE buckets ADD COLUMN owner_user_id TEXT;

-- Map credentials to their owning Telegram user
ALTER TABLE credentials ADD COLUMN owner_user_id TEXT;

-- Map objects/share_tokens don't need owner columns since they reference buckets
-- which already have owner_user_id. We enforce isolation through bucket ownership.
