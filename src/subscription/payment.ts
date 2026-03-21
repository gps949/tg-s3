// Telegram Stars payment handling

import type { Env } from '../types';
import { SubscriptionStore } from './store';
import { PRO_STARS_PRICE, PRO_DURATION_DAYS } from './tiers';

/**
 * Send a Stars invoice to the user via sendInvoice.
 * Uses XTR currency (Telegram Stars).
 */
export async function sendSubscriptionInvoice(chatId: string, env: Env): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      title: 'tg-s3 Pro Subscription',
      description: `Upgrade to Pro: unlimited buckets & files, encryption, image optimization, S3 credentials, share links. Valid for ${PRO_DURATION_DAYS} days.`,
      payload: `pro_monthly_${chatId}_${Date.now()}`,
      currency: 'XTR',
      prices: [{ label: 'Pro Monthly', amount: PRO_STARS_PRICE }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`sendInvoice failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}

/**
 * Create an invoice link (for Mini App payment button).
 * Returns the payment URL or null on failure.
 */
export async function createInvoiceLink(env: Env): Promise<string | null> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'tg-s3 Pro Subscription',
      description: `Unlimited buckets & files, encryption, image optimization, S3 credentials, share links. ${PRO_DURATION_DAYS} days.`,
      payload: `pro_monthly_miniapp_${Date.now()}`,
      currency: 'XTR',
      prices: [{ label: 'Pro Monthly', amount: PRO_STARS_PRICE }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`createInvoiceLink failed (${res.status}): ${body}`);
    return null;
  }
  const data = await res.json() as { ok: boolean; result?: string };
  return data.result || null;
}

/**
 * Handle pre_checkout_query: always approve (Stars payments are instant).
 */
export async function answerPreCheckoutQuery(queryId: string, ok: boolean, env: Env, errorMessage?: string): Promise<void> {
  const body: Record<string, unknown> = {
    pre_checkout_query_id: queryId,
    ok,
  };
  if (!ok && errorMessage) {
    body.error_message = errorMessage;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`answerPreCheckoutQuery failed (${res.status}): ${text}`);
  }
}

/**
 * Process a successful Stars payment: upgrade the user to Pro.
 */
export async function processSuccessfulPayment(
  userId: string,
  totalAmount: number,
  telegramPaymentChargeId: string,
  env: Env,
): Promise<void> {
  const subStore = new SubscriptionStore(env);
  await subStore.upsertSubscription({
    userId,
    tier: 'pro',
    durationDays: PRO_DURATION_DAYS,
    starsPaid: totalAmount,
    paymentId: telegramPaymentChargeId,
  });
}

/**
 * Refund a Stars payment (for admin use or disputes).
 */
export async function refundStarPayment(userId: string, telegramPaymentChargeId: string, env: Env): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/refundStarPayment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: parseInt(userId, 10),
      telegram_payment_charge_id: telegramPaymentChargeId,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`refundStarPayment failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}
