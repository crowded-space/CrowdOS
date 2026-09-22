// Local screenlock PIN store: explicit opt-in, no hardcoded fallback.
// Empty string = disabled (no screenlock configured) — requests then carry no
// PIN headers and a server with nothing configured lets them through.
//
// Precedence: in-memory session PIN > localStorage mirror (`crowdos_pin`) >
// VITE_LOCAL_PIN env override. Plaintext lives only in renderer memory /
// localStorage (desktop has no safeStorage wiring today — main-process
// persistence in plaintext config.json is intentionally NOT used).
//
// ─── CREDENTIAL CHANNEL (do not re-merge) ────────────────────────────
// The PIN travels on `x-pin` ONLY. `Authorization` belongs to the API key
// (SEC-1 `crowd_…`), and the mounted auth gate reads `Authorization` first.
// Sending the PIN there made the gate try to verify it as a key, fail, and
// answer 401 "Missing or invalid API key." on every /api call — a lockout for
// any user who had enabled screenlock. The reverse collision exists too: the
// PIN gate used to read `Authorization`/`x-api-key` as a PIN, so an API-key
// client was misread as presenting a wrong PIN. One credential per header.
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
 *  happens via the Workspace settings screen-lock API. */
export function clearPin(): void {
  setPin('');
}

export function pinHeaders(): Record<string, string> {
  const pin = getPin();
  if (!pin) return {};
  return { 'x-pin': pin };
}

/**
 * Attach the PIN to an init object WITHOUT discarding the caller's headers.
 *
 * `HeadersInit` is a union (Headers | string[][] | Record<string,string>), and
 * `Object.entries()` only enumerates the plain-object arm: a `Headers` instance
 * yields `[]`. The previous merge therefore returned an EMPTY header set for
 * every `apiClient` call (it passes `new Headers(...)`), silently dropping
 * `x-workspace-id` and `Content-Type`. The global patch below is what invokes
 * this, so the loss hit every `/api/*` fetch. Normalizing through
 * `new Headers()` handles all three arms and keeps caller headers intact.
 *
 * The PIN goes on `x-pin` and NOTHING else — see the credential-channel note at
 * the top of this file. `Authorization` is reserved for the API key, and
 * overwriting it here is what caused the 401 lockout.
 */
export function withPinHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const pin = getPin();
  if (pin && !headers.has('x-pin')) headers.set('x-pin', pin);
  return { ...init, headers };
}

// For fetch wrappers that use HeadersInit
export function mergePinHeaders(headers?: HeadersInit): HeadersInit {
  const pin = getPin();
  if (!headers) return pin ? { 'x-pin': pin } : {};
  if (headers instanceof Headers) {
    if (pin && !headers.has('x-pin')) headers.set('x-pin', pin);
    return headers;
  }
  if (Array.isArray(headers)) {
    return pin ? [...headers, ['x-pin', pin]] : headers;
  }
  return pin ? { ...(headers as Record<string, string>), 'x-pin': pin } : headers;
}

/** Auth headers for call sites that build header objects manually. */
export function pinAuthHeaders(): Record<string, string> {
  return pinHeaders();
}

// Global fetch monkey-patch for legacy direct fetch calls (components, store)
// Ensures every /api request carries PIN without touching each call site.
// Idempotent — only patches once. Sends nothing when no PIN is configured.
if (typeof window !== 'undefined' && !(globalThis as any).__pinFetchPatched) {
  try {
    const origFetch = globalThis.fetch.bind(globalThis);
    (globalThis as any).__pinFetchPatched = true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url ?? '';
        if (url.includes('/api/') || url.includes('/socket.io')) {
          init = withPinHeaders(init);
        }
      } catch {}
      return origFetch(input as any, init as any);
    }) as typeof fetch;
  } catch {}
}
