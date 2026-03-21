// Subscription data access layer

import type { Env } from '../types';
import type { Tier } from './tiers';

export interface SubscriptionRow {
  user_id: string;
  tier: Tier;
  starts_at: string;
  expires_at: string | null;
  stars_paid: number;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
}

function isoNowSeconds(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

export class SubscriptionStore {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB;
  }

  async getSubscription(userId: string): Promise<SubscriptionRow | null> {
    return this.db.prepare(
      'SELECT * FROM user_subscriptions WHERE user_id = ?'
    ).bind(userId).first<SubscriptionRow>();
  }

  async getActiveTier(userId: string): Promise<Tier> {
    const sub = await this.getSubscription(userId);
    if (!sub) return 'free';
    if (sub.tier === 'free') return 'free';
    // Check expiry
    if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
      return 'free';
    }
    return sub.tier as Tier;
  }

  async upsertSubscription(params: {
    userId: string;
    tier: Tier;
    durationDays: number;
    starsPaid: number;
    paymentId: string;
  }): Promise<SubscriptionRow> {
    const now = isoNowSeconds();
    const existing = await this.getSubscription(params.userId);

    let startsAt: string;
    let expiresAt: string;

    if (existing && existing.tier === 'pro' && existing.expires_at && new Date(existing.expires_at) > new Date()) {
      // Extend from current expiry
      startsAt = existing.starts_at;
      const currentExpiry = new Date(existing.expires_at);
      currentExpiry.setDate(currentExpiry.getDate() + params.durationDays);
      expiresAt = currentExpiry.toISOString();
    } else {
      // New subscription or expired - start from now
      startsAt = now;
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + params.durationDays);
      expiresAt = expiry.toISOString();
    }

    const totalStars = (existing?.stars_paid || 0) + params.starsPaid;

    await this.db.prepare(`
      INSERT INTO user_subscriptions (user_id, tier, starts_at, expires_at, stars_paid, payment_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        tier = excluded.tier,
        starts_at = excluded.starts_at,
        expires_at = excluded.expires_at,
        stars_paid = excluded.stars_paid,
        payment_id = excluded.payment_id,
        updated_at = excluded.updated_at
    `).bind(
      params.userId, params.tier, startsAt, expiresAt,
      totalStars, params.paymentId, now, now,
    ).run();

    return {
      user_id: params.userId,
      tier: params.tier,
      starts_at: startsAt,
      expires_at: expiresAt,
      stars_paid: totalStars,
      payment_id: params.paymentId,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
  }

  /** Downgrade expired subscriptions back to free (for cron job) */
  async cleanExpiredSubscriptions(): Promise<number> {
    const now = isoNowSeconds();
    const result = await this.db.prepare(
      "UPDATE user_subscriptions SET tier = 'free', updated_at = ? WHERE tier != 'free' AND expires_at IS NOT NULL AND expires_at < ?"
    ).bind(now, now).run();
    return result.meta.changes ?? 0;
  }
}
