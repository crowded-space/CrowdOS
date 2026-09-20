import { io } from "socket.io-client";

// SEC-1 (§19): opt-in API key on the handshake. Read from localStorage at
// module load so a reconnect after a page reload still authenticates. Absent by
// default — the loopback desktop flow needs no credential, and the server
// trusts a keyless loopback handshake.
function readStoredApiKey(): string | undefined {
  try {
    const key = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_api_key') : null;
    return key && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

export const socket = io({
  path: '/socket.io',
  autoConnect: true,
  withCredentials: true,
  auth: (cb: (data: Record<string, unknown>) => void) => cb({ key: readStoredApiKey() }),
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  randomizationFactor: 0.5,
});

// §30: the server keys channel rooms as `ws:<workspaceId>:channel:<channelId>`
// and derives that workspace from the CHANNEL row (never from this claim). The
// workspaceId sent here is advisory context only — the server is authoritative.
// It is still threaded through so the join/leave pair is unambiguous on the
// wire and the debounce cache is scoped per (workspace, channel).
type JoinPayload = { channelId: string; workspaceId?: string | null };

function joinCacheKey(channelId: string, workspaceId?: string | null): string {
  return (workspaceId || '') + '|' + channelId;
}

function joinPayload(channelId: string, workspaceId?: string | null): JoinPayload {
  return workspaceId ? { channelId, workspaceId } : { channelId };
}

const lastJoinAt: Record<string, number> = {};
const pendingJoinTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const pendingJoinIds = new Set<string>();
const JOIN_DEBOUNCE_MS = 400;

// Prune lastJoinAt to avoid unbounded growth (keep last 100)
function pruneJoinCache() {
  const keys = Object.keys(lastJoinAt);
  if (keys.length > 120) {
    const sorted = keys.sort((a, b) => lastJoinAt[a] - lastJoinAt[b]);
    for (let i = 0; i < sorted.length - 100; i++) delete lastJoinAt[sorted[i]];
  }
}

export function emitChannelJoin(channelId: string, workspaceId?: string | null) {
  if (!channelId) return;
  const key = joinCacheKey(channelId, workspaceId);
  const now = Date.now();
  const last = lastJoinAt[key] ?? 0;
  if (now - last < JOIN_DEBOUNCE_MS) {
    // Per-(workspace,channel) debounce (fixes single-slot collapse chA→chB→chC => only chC)
    pendingJoinIds.add(key);
    if (pendingJoinTimers[key]) clearTimeout(pendingJoinTimers[key]!);
    pendingJoinTimers[key] = setTimeout(() => {
      delete pendingJoinTimers[key];
      pendingJoinIds.delete(key);
      lastJoinAt[key] = Date.now();
      pruneJoinCache();
      try { socket.emit('channel:join' as any, joinPayload(channelId, workspaceId)); } catch {}
    }, JOIN_DEBOUNCE_MS);
    return;
  }
  lastJoinAt[key] = now;
  pruneJoinCache();
  try { socket.emit('channel:join' as any, joinPayload(channelId, workspaceId)); } catch {}
}

export function emitChannelLeave(channelId: string, workspaceId?: string | null) {
  if (!channelId) return;
  try { socket.emit('channel:leave' as any, joinPayload(channelId, workspaceId)); } catch {}
}

export function emitWorkspaceLeave(workspaceId: string) {
  if (!workspaceId) return;
  try { socket.emit('workspace:leave' as any, { workspaceId }); } catch {}
}

export function cleanupSocketJoins() {
  for (const t of Object.values(pendingJoinTimers)) clearTimeout(t as any);
  for (const k of Object.keys(pendingJoinTimers)) delete pendingJoinTimers[k];
  pendingJoinIds.clear();
}

socket.on('connect', () => {
  try {
    const active = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
    // §30: re-join the persisted channel within its workspace scope.
    const activeWorkspace = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_workspace') : null;
    if (active) emitChannelJoin(active, activeWorkspace);
  } catch {}
});

socket.on('connect_error', (err: any) => {
  // Surface offline without spamming console; store will show banner via socket events
  if (typeof console !== 'undefined' && err?.message) {
    // throttle log to once per 5s
    const now = Date.now();
    const last = (socket as any).__lastConnErrAt || 0;
    if (now - last > 5000) {
      (socket as any).__lastConnErrAt = now;
      console.warn('[socket] connect_error', err.message);
    }
  }
});

socket.on('reconnect_failed', () => {
  console.error('[socket] reconnect_failed — offline');
});

export function refreshSocketPin(_pin?: string | null): void {
  // Socket auth refresh hook
}

/**
 * Store the API key for BOTH transports and re-handshake so the new credential
 * takes effect without a page reload. Passing null clears it and returns the
 * client to keyless (loopback) mode.
 */
export function setSocketApiKey(key: string | null): void {
  const normalized = key && key.trim() ? key.trim() : null;
  try {
    if (typeof localStorage !== 'undefined') {
      if (normalized) localStorage.setItem('crowdos_api_key', normalized);
      else localStorage.removeItem('crowdos_api_key');
    }
  } catch {
    // Storage unavailable (private mode): the in-memory handshake below still applies.
  }
  try {
    (socket as any).auth = { key: normalized ?? undefined };
    if (socket.connected) {
      socket.disconnect();
      socket.connect();
    }
  } catch {}
}

export function getSocketApiKey(): string | null {
  return readStoredApiKey() ?? null;
}

