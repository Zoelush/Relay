/**
 * Rate limits for the public API (phase 15, D1): token buckets, per token and per workspace. The
 * port lets a deployment keep its buckets where every request sees them (TODO(phase 15 deploy): a
 * Durable Object per workspace in workers/relay.ts); locally and in tests they're in memory.
 */
export type Bucket = { capacity: number; perSecond: number };
export type Taken = { ok: boolean; remaining: number; resetSeconds: number; retryAfterSeconds: number };
export interface RateLimiter {
  take(key: string, bucket: Bucket, now?: number): Taken;
}

/** The documented limits: a burst of 100 per token refilling at 10 a second (600 a minute), and 1,500 a minute per workspace. */
export const LIMITS = {
  token: { capacity: 100, perSecond: 10 } satisfies Bucket,
  workspace: { capacity: 300, perSecond: 25 } satisfies Bucket,
};

export function memoryRateLimiter(): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, bucket, now = Date.now()) {
      const b = buckets.get(key) ?? { tokens: bucket.capacity, at: now };
      b.tokens = Math.min(bucket.capacity, b.tokens + ((now - b.at) / 1000) * bucket.perSecond);
      b.at = now;
      const ok = b.tokens >= 1;
      if (ok) b.tokens -= 1;
      buckets.set(key, b);
      return {
        ok,
        remaining: Math.floor(b.tokens),
        resetSeconds: Math.ceil((bucket.capacity - b.tokens) / bucket.perSecond),
        retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / bucket.perSecond)),
      };
    },
  };
}
