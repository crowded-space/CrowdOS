/**
 * SEC-5 fold-in: per-socket token-bucket throttle for user-content-producing
 * socket events. Passive events (join/typing/ping/cancel) are never throttled.
 *
 * Defaults: capacity 15, refill 5 tokens/second.
 * Env: SOCKET_MSG_RATE_CAPACITY, SOCKET_MSG_RATE_REFILL (tokens per second).
 */

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

const DEFAULT_CAPACITY = 15;
const DEFAULT_REFILL_PER_SECOND = 5;

function envNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getRateLimitConfig(): RateLimitConfig {
  return {
    capacity: envNumber(process.env.SOCKET_MSG_RATE_CAPACITY) ?? DEFAULT_CAPACITY,
    refillPerSecond: envNumber(process.env.SOCKET_MSG_RATE_REFILL) ?? DEFAULT_REFILL_PER_SECOND,
  };
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    public readonly capacity: number,
    public readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(now: number): void {
    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillAt = now;
  }

  tryTake(cost = 1): boolean {
    this.refill(Date.now());
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}

const THROTTLED_EVENTS: ReadonlySet<string> = new Set(["user:message"]);

export function isThrottledEvent(eventType: string): boolean {
  return THROTTLED_EVENTS.has(eventType);
}

export interface SocketRateLimiter {
  consume(socketId: string): boolean;
  release(socketId: string): void;
  readonly size: number;
}

// P37: the bucket map is keyed by socket id, so without pruning it grows
// without bound on a long-lived server. Cap at 10k entries (LRU eviction)
// + prune buckets idle for 5 minutes every 60s.
const MAX_BUCKETS = 10_000;
const PRUNE_INTERVAL_MS = 60_000;
const BUCKET_IDLE_TTL_MS = 5 * 60_000;

export function createSocketRateLimiter(config: RateLimitConfig = getRateLimitConfig()): SocketRateLimiter {
  const buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - BUCKET_IDLE_TTL_MS;
    for (const [id, entry] of buckets) {
      if (entry.lastSeen < cutoff) buckets.delete(id);
    }
  }, PRUNE_INTERVAL_MS);
  (pruneTimer as unknown as { unref?: () => void }).unref?.();
  return {
    consume(socketId: string): boolean {
      const now = Date.now();
      let entry = buckets.get(socketId);
      if (!entry) {
        entry = { bucket: new TokenBucket(config.capacity, config.refillPerSecond), lastSeen: now };
        buckets.set(socketId, entry);
        if (buckets.size > MAX_BUCKETS) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
        }
      } else {
        // LRU refresh: re-insert to mark as most recently used.
        buckets.delete(socketId);
        entry.lastSeen = now;
        buckets.set(socketId, entry);
      }
      return entry.bucket.tryTake(1);
    },
    release(socketId: string): void {
      buckets.delete(socketId);
    },
    get size(): number {
      return buckets.size;
    },
  };
}
