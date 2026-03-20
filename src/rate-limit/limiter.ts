interface Bucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per ms
  lastRefill: number;
}

function createBucket(maxTokens: number, refillPerSecond: number): Bucket {
  return { tokens: maxTokens, maxTokens, refillRate: refillPerSecond / 1000, lastRefill: Date.now() };
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(b.maxTokens, b.tokens + elapsed * b.refillRate);
  b.lastRefill = now;
}

function tryConsumeBucket(b: Bucket): boolean {
  refill(b);
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

function retryAfterBucket(b: Bucket): number {
  refill(b);
  if (b.tokens >= 1) return 0;
  return Math.ceil((1 - b.tokens) / b.refillRate / 1000);
}

const MAX_CHANNELS = 256;

export class RateLimiter {
  private global: Bucket;
  private channels = new Map<string, Bucket>();

  constructor() {
    // Global: 22 tokens/sec (safe margin from 30/sec)
    this.global = createBucket(22, 22);
  }

  private getChannel(chatId: string): Bucket {
    let b = this.channels.get(chatId);
    if (b) {
      // Move to end (most recently used) by re-inserting
      this.channels.delete(chatId);
      this.channels.set(chatId, b);
      return b;
    }
    // Evict oldest entries if at capacity
    if (this.channels.size >= MAX_CHANNELS) {
      const oldest = this.channels.keys().next().value!;
      this.channels.delete(oldest);
    }
    // Per channel: 15 tokens/min = 0.25/sec
    b = createBucket(15, 0.25);
    this.channels.set(chatId, b);
    return b;
  }

  tryConsume(chatId: string): boolean {
    const ch = this.getChannel(chatId);
    if (!tryConsumeBucket(this.global)) return false;
    if (!tryConsumeBucket(ch)) {
      // Refund global token
      this.global.tokens = Math.min(this.global.maxTokens, this.global.tokens + 1);
      return false;
    }
    return true;
  }

  getRetryAfter(chatId: string): number {
    const ch = this.getChannel(chatId);
    return Math.max(retryAfterBucket(this.global), retryAfterBucket(ch));
  }
}

// Singleton - survives across requests in same isolate
let instance: RateLimiter | null = null;
export function getRateLimiter(): RateLimiter {
  if (!instance) instance = new RateLimiter();
  return instance;
}
