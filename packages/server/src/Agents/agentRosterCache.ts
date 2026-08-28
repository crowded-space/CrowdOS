import { TtlCache } from "../Shared/core/ttlCache.js";
import type { AgentProfile } from "./agentTypes.js";

/**
 * PERF-2: hot-path roster cache. Agent rosters were scanned from the DB twice
 * per send dispatch (mention resolution + trigger routing). This cache folds
 * repeated list() shapes into one query per 30s window. Only post-filter
 * results (archived rows already excluded by DB-3 guards) are ever stored.
 *
 * Single-flight: the cached value is the loader promise, so concurrent misses
 * collapse into one query. A failed load evicts itself so a transient DB error
 * is never pinned for the full TTL.
 */

const ROSTER_TTL_MS = 30_000;
const ROSTER_MAX_KEYS = 50;

const cache = new TtlCache<Promise<AgentProfile[]>>(ROSTER_TTL_MS, ROSTER_MAX_KEYS);

let testOverrideEnabled: boolean | null = null;

function cachingEnabled(): boolean {
  if (testOverrideEnabled !== null) return testOverrideEnabled;
  // Deterministic hermetic tests seed fake stores directly (bypassing gate
  // mutations), so cross-request caching stays off under vitest unless a test
  // explicitly opts in via enableRosterCacheForTests.
  return process.env.VITEST !== "true";
}

export function getCachedRoster(
  key: string,
  loader: () => Promise<AgentProfile[]>,
): Promise<AgentProfile[]> {
  if (!cachingEnabled()) return loader();

  const pending = cache.get(key);
  if (pending) return pending;

  const promise = loader().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  return promise;
}

export function invalidateRosterCache(): void {
  cache.clear();
}

export function enableRosterCacheForTests(): () => void {
  const previous = testOverrideEnabled;
  testOverrideEnabled = true;
  invalidateRosterCache();
  return () => {
    testOverrideEnabled = previous;
    invalidateRosterCache();
  };
}
