// Local screenlock PIN store: explicit opt-in, no hardcoded fallback.
// Empty string = disabled (no screenlock configured) — requests then carry no
// PIN headers and a server with nothing configured lets them through.
//
// Precedence: in-memory session PIN > localStorage mirror (`crowdos_pin`) >
// VITE_LOCAL_PIN env override. Plaintext lives only in renderer memory /
// localStorage (desktop has no safeStorage wiring today — main-process
// persistence in plaintext config.json is intentionally NOT used).
// All call sites must use headers via withPinHeaders / pinHeaders / mergePinHeaders.
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
  return { 'x-pin': pin, Authorization: `Bearer ${pin}` };
}

export function withPinHeaders(init?: RequestInit): RequestInit {
  const pin = getPin();
  const headers: Record<string, string> = pin ? { 'x-pin': pin, Authorization: `Bearer ${pin}` } : {};
  if (init?.headers) {
    const existing = init.headers as Record<string, string>;
    for (const [k, v] of Object.entries(existing)) headers[k] = v as string;
  }
  return { ...init, headers };
}

// For fetch wrappers that use HeadersInit
export function mergePinHeaders(headers?: HeadersInit): HeadersInit {
  const pin = getPin();
  const base: Record<string, string> = pin ? { 'x-pin': pin, Authorization: `Bearer ${pin}` } : {};
  if (!headers) return base;
  if (headers instanceof Headers) {
    if (pin) {
      headers.set('x-pin', pin);
      headers.set('Authorization', `Bearer ${pin}`);
    }
    return headers;
  }
  if (Array.isArray(headers)) {
    return pin ? [...headers, ['x-pin', pin], ['Authorization', `Bearer ${pin}`]] : headers;
  }
  return { ...base, ...(headers as Record<string, string>) };
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
