/**
 * PERF-9 · Provider HTTP keep-alive.
 *
 * Delivery status (honest): the `undici` npm package is NOT resolvable in this
 * workspace (only the types-only `undici-types` ships transitively), and adding
 * it was forbidden this wave. Node's global fetch (used by every provider
 * adapter via providerFetch) already pools connections per origin with HTTP
 * keep-alive enabled by default — verified against a local origin counting
 * distinct sockets across sequential requests. Therefore adapters are warm-path
 * pooled today; a custom Agent would add explicit tuning (pipelining,
 * keepAliveTimeout, connection caps) on top.
 *
 * This module probes for `undici` lazily at runtime WITHOUT a static import:
 * if the package ever becomes installable/resolvable, getProviderDispatcher()
 * starts returning an Agent configured below and providerFetch automatically
 * attaches it as `dispatcher` to every adapter fetch call (coexisting with the
 * CAN-1 composed abort signal). Until then it resolves undefined and fetch
 * proceeds exactly as before.
 */

export interface ProviderKeepAliveConfig {
  keepAliveTimeoutMs: number;
  keepAliveMaxTimeoutMs: number;
  pipelining: number;
  connectionsPerOrigin: number;
}

export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 10_000;
export const DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_PIPELINING = 4;
export const DEFAULT_CONNECTIONS_PER_ORIGIN = 8;

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function getProviderKeepAliveConfig(): ProviderKeepAliveConfig {
  return {
    keepAliveTimeoutMs: parsePositiveInt(process.env.PROVIDER_KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, 600_000),
    keepAliveMaxTimeoutMs: parsePositiveInt(process.env.PROVIDER_KEEP_ALIVE_MAX_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS, 3_600_000),
    pipelining: parsePositiveInt(process.env.PROVIDER_PIPELINING, DEFAULT_PIPELINING, 4),
    connectionsPerOrigin: parsePositiveInt(process.env.PROVIDER_MAX_CONNECTIONS, DEFAULT_CONNECTIONS_PER_ORIGIN, 256),
  };
}

let dispatcherOverride: unknown | null = null;

/** Test hook only: force the dispatcher probe outcome. */
export function _setUndiciDispatcherForTesting(value: unknown | null): void {
  dispatcherOverride = value;
}

let cachedDispatcher: unknown | undefined | null = null;

async function probeUndiciAgent(): Promise<unknown | undefined> {
  try {
    const specifier = 'undici';
    const mod = (await import(specifier)) as { Agent?: unknown; default?: { Agent?: unknown } };
    const AgentCtor = mod.Agent ?? mod.default?.Agent;
    if (typeof AgentCtor !== 'function') return undefined;
    const cfg = getProviderKeepAliveConfig();
    const Agent = AgentCtor as new (options: Record<string, unknown>) => unknown;
    return new Agent({
      keepAliveTimeout: cfg.keepAliveTimeoutMs,
      keepAliveMaxTimeout: cfg.keepAliveMaxTimeoutMs,
      pipelining: cfg.pipelining,
      connections: cfg.connectionsPerOrigin,
    });
  } catch {
    return undefined;
  }
}

/**
 * Returns an undici Agent when the package is resolvable, otherwise undefined.
 * Result is cached; the first call performs one dynamic import attempt.
 */
export async function getProviderDispatcher(): Promise<unknown | undefined> {
  if (dispatcherOverride !== null) return dispatcherOverride ?? undefined;
  if (cachedDispatcher === null) {
    cachedDispatcher = await probeUndiciAgent();
  }
  return cachedDispatcher;
}

export interface ProviderKeepAliveStatus {
  undiciDispatcherActive: boolean;
  globalFetchPooledByDefault: boolean;
  note: string;
  config: ProviderKeepAliveConfig;
}

export async function getProviderKeepAliveStatus(): Promise<ProviderKeepAliveStatus> {
  const dispatcher = await getProviderDispatcher();
  return {
    undiciDispatcherActive: dispatcher !== undefined,
    globalFetchPooledByDefault: true,
    note:
      dispatcher !== undefined
        ? 'undici Agent attached as fetch dispatcher for all provider adapters.'
        : 'undici package not resolvable (not installed); Node >=18 global fetch already pools connections per origin with keep-alive by default. Custom Agent tuning activates automatically once undici is added.',
    config: getProviderKeepAliveConfig(),
  };
}
