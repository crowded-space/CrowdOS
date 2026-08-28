import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

type RateLimitErrorContext = { max: number; ttl: number; after: string };

const RATE_LIMIT_RETRY_MARK = Symbol("crowdos.rateLimitRetryAfterMs");

export interface RateLimitOverrides {
  max?: number;
  timeWindowMs?: number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isRateLimitEnabled(): boolean {
  return (process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

export function buildRateLimitOptions(overrides: RateLimitOverrides = {}) {
  const max = overrides.max ?? readPositiveInt(process.env.RATE_LIMIT_MAX, 300);
  const timeWindowMs = overrides.timeWindowMs ?? readPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);

  return {
    global: true,
    max,
    timeWindow: timeWindowMs,
    keyGenerator: (request: FastifyRequest) => String(request.identity?.id ?? request.ip),
    allowList: (request: FastifyRequest) => {
      const path = (request.url || "").split("?")[0];
      return path === "/health" || path === "/api/health";
    },
    errorResponseBuilder: (request: FastifyRequest, context: RateLimitErrorContext) => {
      const retryAfterMs = Math.max(0, Math.ceil(context.ttl));
      (request as unknown as Record<symbol, unknown>)[RATE_LIMIT_RETRY_MARK] = retryAfterMs;
      const error: Error & { statusCode?: number } = new Error("Rate limit exceeded.");
      error.name = "rate_limited";
      error.statusCode = 429;
      return error;
    },
  };
}

export async function registerRateLimit(
  app: FastifyInstance,
  overrides: RateLimitOverrides = {}
): Promise<boolean> {
  if (!isRateLimitEnabled()) return false;

  await app.register(rateLimit, buildRateLimitOptions(overrides));

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const retryAfterMs = (request as unknown as Record<symbol, unknown>)[RATE_LIMIT_RETRY_MARK];
    if (retryAfterMs === undefined || reply.statusCode !== 429) return payload;
    return JSON.stringify({
      statusCode: 429,
      error: "rate_limited",
      message: "Rate limit exceeded.",
      retryAfterMs,
    });
  });

  return true;
}
