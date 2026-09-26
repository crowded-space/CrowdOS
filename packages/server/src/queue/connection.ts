import IORedis from "ioredis";

let shared: InstanceType<typeof IORedis> | null = null;

let lastRedisWarn = 0;
function warnRedis(err: unknown): void {
  // ponytail: 60s throttle — reconnect storms must not flood logs, silence hid outages
  const now = Date.now();
  if (now - lastRedisWarn < 60000) return;
  lastRedisWarn = now;
  console.warn("[queue:redis]", (err as Error)?.message ?? err);
}

export function getQueueMode(): "inline" | "bullmq" {
  const raw = process.env.QUEUE_MODE?.trim().toLowerCase();
  return raw === "bullmq" ? "bullmq" : "inline";
}

export function getRedisUrl(): string {
  const raw = process.env.REDIS_URL?.trim();
  if (raw && raw.length > 0) return raw;
  return "redis://localhost:6379";
}

export function isInlineMode(): boolean {
  return getQueueMode() === "inline";
}

export function getRedisConnection(): InstanceType<typeof IORedis> | null {
  if (isInlineMode()) return null;
  if (shared) return shared;
  const url = getRedisUrl();
  shared = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  shared.on("error", warnRedis);
  return shared;
}

export function createRedisConnection(): InstanceType<typeof IORedis> | null {
  if (isInlineMode()) return null;
  const url = getRedisUrl();
  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  conn.on("error", warnRedis);
  return conn;
}

export async function closeConnection(): Promise<void> {
  if (shared) {
    const c = shared;
    shared = null;
    try {
      await c.quit();
    } catch {
      try {
        c.disconnect();
      } catch {}
    }
  }
}

export function resetConnectionForTests(): void {
  shared = null;
}
