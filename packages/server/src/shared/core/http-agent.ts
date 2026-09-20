/**
 * PERF-9 · Provider HTTP keep-alive.
 *
 * Delivery status (honest): `undici` IS resolvable in this workspace (hoisted
 * transitively via electron/electron-builder), so getProviderDispatcher()
 * returns an Agent configured below and providerFetch attaches it as
 * `dispatcher` on every adapter fetch (coexisting with the CAN-1 composed
 * abort signal). The lazy probe keeps installs without a resolvable undici
 * working unchanged: Node >=18 global fetch already pools connections per
 * origin with keep-alive enabled by default, so adapters are warm-path pooled
 * either way; the Agent adds explicit tuning (pipelining, keepAliveTimeout,
 * connection caps) when available.
 *
 * The probe is dynamic (no static import) so a missing package degrades to
 * `undefined` instead of breaking module load.
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

let cachedDispatcher: unknown | undefined | null = null;

/**
 * Explicit override state: `null` = no override (probe lazily), otherwise the
 * forced value held in `value`. A holder (not a bare sentinel) so tests can
 * force *unavailable* (`undefined`/`null`) as well as a concrete dispatcher.
 */
let dispatcherOverride: { value: unknown } | null = null;

/**
 * Test hook only: force the dispatcher resolution outcome. Pass the value to
 * force — `undefined` (or `null`) forces "unavailable". Call
 * `_resetUndiciDispatcherForTesting()` to restore lazy probe semantics.
 */
export function _setUndiciDispatcherForTesting(value: unknown): void {
  dispatcherOverride = { value };
  // Any override change invalidates the probe cache so a later reset re-probes
  // instead of serving a stale result from a different override regime.
  cachedDispatcher = null;
}

/** Test hook only: clear any forced override and re-enable lazy probing. */
export function _resetUndiciDispatcherForTesting(): void {
  dispatcherOverride = null;
  cachedDispatcher = null;
}

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
 * A test override (see `_setUndiciDispatcherForTesting`) short-circuits the
 * probe entirely, including forced-unavailable (`undefined`/`null`).
 */
export async function getProviderDispatcher(): Promise<unknown | undefined> {
  if (dispatcherOverride !== null) return dispatcherOverride.value ?? undefined;
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
