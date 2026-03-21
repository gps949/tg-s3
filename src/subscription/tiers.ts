// Subscription tier definitions and limit enforcement

export interface TierLimits {
  maxBuckets: number;         // max number of buckets
  maxFilesPerBucket: number;  // max files per bucket (0 = unlimited)
  maxTotalFiles: number;      // max total files across all buckets (0 = unlimited)
  encryption: boolean;        // SSE-S3 encryption allowed
  imageOptimization: boolean; // image optimization (WebP/AVIF conversion) allowed
  customCredentials: boolean; // S3 API credentials allowed
  shareLinks: boolean;        // share link creation allowed
  maxCredentials: number;     // max S3 credentials
}

export type Tier = 'free' | 'pro';

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    maxBuckets: 1,
    maxFilesPerBucket: 1000,
    maxTotalFiles: 1000,
    encryption: false,
    imageOptimization: false,
    customCredentials: false,
    shareLinks: false,
    maxCredentials: 0,
  },
  pro: {
    maxBuckets: 0,  // unlimited
    maxFilesPerBucket: 0,
    maxTotalFiles: 0,
    encryption: true,
    imageOptimization: true,
    customCredentials: true,
    shareLinks: true,
    maxCredentials: 100,
  },
};

// Stars pricing
export const PRO_STARS_PRICE = 200;  // 200 Stars per month (~$4)
export const PRO_DURATION_DAYS = 30;

export function getTierLimits(tier: Tier): TierLimits {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}
