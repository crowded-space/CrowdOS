// Local screenlock PIN store: explicit opt-in, no hardcoded fallback.
// Empty string = disabled (no screenlock configured) — requests then carry no
// PIN headers and a server with nothing configured lets them through.
//
// Precedence: in-memory session PIN > localStorage mirror (`crowdos_pin`) >
// VITE_LOCAL_PIN env override. Plaintext lives only in renderer memory /
// localStorage (desktop has no safeStorage wiring today — main-process
// persistence in plaintext config.json is intentionally NOT used).
//
// ─── TENANT CHANNEL (x-workspace-id) ─────────────────────────────────
// The server resolves the workspace tenant ONLY from the x-workspace-id
// header (create-app.ts onRequest hook). Legacy direct fetch() calls in
// crowdOsStore.ts (createCategory/createChannel/addAgent, message pages,
// budget telemetry) bypassed apiClient and sent no tenant header, so every
// local-mode write fell back to the "default" scope: categories/agents
// were silently misfiled into <workspaces>/default, and channel creation
// answered 400 "Category not found" for a category that existed in the
// active workspace. The patch below injects the ACTIVE workspace id into
// every local /api/ fetch whose caller did not set an explicit tenant header.
type WorkspaceIdGetter = () => string | null;

const WORKSPACE_GETTER_KEY = '__crowdOsActiveWorkspaceIdGetter';
const FETCH_PATCHED_KEY = '__pinFetchPatched';
const globalState = globalThis as typeof globalThis & Record<string, unknown>;

/** Registered by the store at module load so this config layer can scope
 * requests without importing the store (import-cycle guard).
 *
 * Store the getter globally so the installed fetch wrapper does not retain a
 * stale module closure after a Vite hot reload.
 */
export function setActiveWorkspaceIdGetter(getter: WorkspaceIdGetter): void {
  globalState[WORKSPACE_GETTER_KEY] = typeof getter === 'function' ? getter : () => null;
}

function activeWorkspaceIdForRequest(): string | null {
  try {
    const getter = globalState[WORKSPACE_GETTER_KEY];
    if (typeof getter !== 'function') return null;

    const value = (getter as WorkspaceIdGetter)();
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Attach the active tenant header when the caller did not set one. */
export function withTenantHeaders(init?: RequestInit): RequestInit {
  const wsId = activeWorkspaceIdForRequest();
  if (!wsId) return init ?? {};

  const headers = new Headers(init?.headers);
  if (!headers.has('x-workspace-id')) headers.set('x-workspace-id', wsId);
  return { ...init, headers };
}

// ─── CREDENTIAL CHANNEL (do not re-merge) ────────────────────────────
// The PIN travels on `x-pin` ONLY. `Authorization` belongs to the API key.
const STORAGE_KEY = 'crowdos_pin';

// In-memory session copy: the source of truth once loaded, so the PIN can
// live memory-only (clearPin drops it everywhere; setPin re-mirrors it).
let memoryPin: string | undefined;

function readStoredPin(): string {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored && stored.trim()) return stored.trim();
  } catch {}

  // Vite env override (operator-configured), no default when absent.
  try {
    const envPin = (import.meta as any)?.env?.VITE_LOCAL_PIN;
    if (envPin && String(envPin).trim()) return String(envPin).trim();
  } catch {}

  return '';
}

export function getPin(): string {
  if (memoryPin === undefined) memoryPin = readStoredPin();
  return memoryPin;
}

/** True when a screenlock PIN is currently configured on this client. */
export function hasPin(): boolean {
  return getPin().length > 0;
}

export function setPin(pin: string): void {
  memoryPin = pin.trim();
  try {
    if (typeof localStorage !== 'undefined') {
      if (memoryPin) localStorage.setItem(STORAGE_KEY, memoryPin);
      else localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

/** Disable the local screenlock copy (memory + mirror). Server-side disable
 * happens via the Workspace settings screen-lock API. */
export function clearPin(): void {
  setPin('');
}

export function pinHeaders(): Record<string, string> {
  const pin = getPin();
  return pin ? { 'x-pin': pin } : {};
}

/** Attach the PIN without discarding or mutating the caller's headers. */
export function withPinHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const pin = getPin();
  if (pin && !headers.has('x-pin')) headers.set('x-pin', pin);
  return { ...init, headers };
}

/** Normalize every HeadersInit variant without mutating the supplied value. */
export function mergePinHeaders(headers?: HeadersInit): HeadersInit {
  const merged = new Headers(headers);
  const pin = getPin();
  if (pin && !merged.has('x-pin')) merged.set('x-pin', pin);
  return merged;
}

/** Auth headers for call sites that build header objects manually. */
export function pinAuthHeaders(): Record<string, string> {
  return pinHeaders();
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Only modify same-origin API and Socket.IO requests. */
function isLocalApiRequest(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(getRequestUrl(input), window.location.href);
    if (url.origin !== window.location.origin) return false;

    return (
      url.pathname === '/api' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/socket.io' ||
      url.pathname.startsWith('/socket.io/')
    );
  } catch {
    return false;
  }
}

/**
 * Preserve headers carried by a Request object, then apply explicit init
 * headers using native fetch precedence. The old wrapper built headers from
 * init alone, so fetch(new Request(...)) could lose Authorization,
 * Content-Type, and x-workspace-id when the wrapper supplied its own init.
 */
function prepareApiRequestInit(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);

  // Per fetch semantics, explicit init headers override Request headers.
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

  return withTenantHeaders(withPinHeaders({ ...init, headers }));
}

// Global fetch patch for legacy direct fetch calls. Idempotent and restricted
// to local API traffic; external requests are left untouched.
if (typeof window !== 'undefined' && !globalState[FETCH_PATCHED_KEY]) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalState[FETCH_PATCHED_KEY] = true;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const nextInit = isLocalApiRequest(input) ? prepareApiRequestInit(input, init) : init;
    return originalFetch(input, nextInit);
  }) as typeof fetch;
}
