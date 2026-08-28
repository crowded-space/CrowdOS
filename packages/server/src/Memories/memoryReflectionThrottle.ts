import { boolEnv, numEnv } from "./memoryEnv.js";

const MIN_INTERVAL_MS_DEFAULT = 60_000;
const SIMILARITY_THRESHOLD_DEFAULT = 0.8;
const HOOK_RING_SIZE = 25;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "was", "were", "are",
  "but", "not", "has", "had", "have", "will", "would", "could", "should",
  "into", "about", "out", "just", "very", "when", "what", "which", "their",
  "them", "then", "than", "they", "its", "it's", "also", "because", "been",
]);

export interface ReflectionThrottleDecision {
  allowed: boolean;
  reason?: "throttled" | "duplicate_hook";
}

export function normalizeHookTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

class ReflectionThrottle {
  private lastWriteAt = new Map<string, number>();
  private recentHooks = new Map<string, string[]>();

  check(agentId: string, hook: string, now: number = Date.now()): ReflectionThrottleDecision {
    if (!boolEnv("MEM_REFLECT_THROTTLE", true)) return { allowed: true };

    const minIntervalMs = numEnv("MEM_REFLECT_MIN_INTERVAL_MS", MIN_INTERVAL_MS_DEFAULT);
    const last = this.lastWriteAt.get(agentId);
    if (last != null && now - last < minIntervalMs) {
      return { allowed: false, reason: "throttled" };
    }

    const threshold = numEnv("MEM_REFLECT_SIMILARITY_PCT", Math.round(SIMILARITY_THRESHOLD_DEFAULT * 100)) / 100;
    const tokens = normalizeHookTokens(hook);
    if (tokens.length > 0) {
      const hooks = this.recentHooks.get(agentId) ?? [];
      for (const prior of hooks) {
        if (jaccardSimilarity(tokens, normalizeHookTokens(prior)) >= threshold) {
          return { allowed: false, reason: "duplicate_hook" };
        }
      }
    }
    return { allowed: true };
  }

  record(agentId: string, hook: string, now: number = Date.now()): void {
    this.lastWriteAt.set(agentId, now);
    const hooks = this.recentHooks.get(agentId) ?? [];
    hooks.push(hook);
    while (hooks.length > HOOK_RING_SIZE) hooks.shift();
    this.recentHooks.set(agentId, hooks);
  }

  reset(): void {
    this.lastWriteAt.clear();
    this.recentHooks.clear();
  }
}

export const reflectionThrottle = new ReflectionThrottle();
