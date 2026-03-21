// Subscription enforcement middleware for Mini App API and bot operations

import type { Env, BucketRow } from '../types';
import { SubscriptionStore } from './store';
import { getTierLimits, type Tier } from './tiers';
import { MetadataStore } from '../storage/metadata';

export interface UserContext {
  userId: string;
  tier: Tier;
}

/**
 * Extract user ID from Telegram WebApp initData in the Authorization header.
 * The bearer token is the raw initData query string which contains user={...}.
 */
export function extractUserIdFromInitData(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const initData = auth.slice(7);
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    return user.id?.toString() || null;
  } catch {
    return null;
  }
}

/**
 * Get user context (ID + active tier) from a request.
 */
export async function getUserContext(request: Request, env: Env): Promise<UserContext | null> {
  const userId = extractUserIdFromInitData(request);
  if (!userId) return null;
  const subStore = new SubscriptionStore(env);
  const tier = await subStore.getActiveTier(userId);
  return { userId, tier };
}

/**
 * List only buckets owned by this user.
 * Legacy buckets (without owner_user_id) are visible to all users.
 */
export async function listUserBuckets(userId: string, env: Env): Promise<BucketRow[]> {
  const store = new MetadataStore(env);
  const allBuckets = await store.listBuckets();
  return allBuckets.filter(b => !b.owner_user_id || b.owner_user_id === userId);
}

/**
 * Check if a user owns a specific bucket.
 */
export async function userOwnsBucket(userId: string, bucketName: string, env: Env): Promise<boolean> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(bucketName);
  if (!bucket) return false;
  // Buckets without owner_user_id are legacy (pre-multi-tenant) and accessible to all
  if (!bucket.owner_user_id) return true;
  return bucket.owner_user_id === userId;
}

/**
 * Enforce tier limits before a bucket creation operation.
 * Returns an error message if the limit is exceeded, or null if allowed.
 */
export async function checkBucketCreationLimit(userId: string, tier: Tier, env: Env): Promise<string | null> {
  const limits = getTierLimits(tier);
  if (limits.maxBuckets === 0) return null; // unlimited
  const userBuckets = await listUserBuckets(userId, env);
  if (userBuckets.length >= limits.maxBuckets) {
    return `Bucket limit reached (${limits.maxBuckets} for ${tier} tier). Upgrade to Pro for unlimited buckets.`;
  }
  return null;
}

/**
 * Enforce tier limits before a file upload operation.
 * Returns an error message if the limit is exceeded, or null if allowed.
 */
export async function checkFileUploadLimit(userId: string, tier: Tier, bucketName: string, env: Env): Promise<string | null> {
  const limits = getTierLimits(tier);
  if (limits.maxFilesPerBucket === 0) return null; // unlimited

  const store = new MetadataStore(env);
  const bucket = await store.getBucket(bucketName);
  if (!bucket) return 'Bucket not found';

  if (bucket.object_count >= limits.maxFilesPerBucket) {
    return `File limit reached (${limits.maxFilesPerBucket} per bucket for ${tier} tier). Upgrade to Pro for unlimited files.`;
  }
  return null;
}

/**
 * Check if a feature is allowed for the user's tier.
 */
export function checkFeatureAccess(tier: Tier, feature: 'encryption' | 'imageOptimization' | 'customCredentials' | 'shareLinks'): string | null {
  const limits = getTierLimits(tier);
  if (limits[feature]) return null;
  const featureNames: Record<string, string> = {
    encryption: 'Encryption',
    imageOptimization: 'Image optimization',
    customCredentials: 'Custom S3 credentials',
    shareLinks: 'Share links',
  };
  return `${featureNames[feature]} requires a Pro subscription. Use /subscribe to upgrade.`;
}
