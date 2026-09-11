import { io } from "socket.io-client";

export const socket = io({
  path: '/socket.io',
  autoConnect: true,
  withCredentials: true,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  randomizationFactor: 0.5,
});

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

export function emitChannelJoin(channelId: string) {
  if (!channelId) return;
  const now = Date.now();
  const last = lastJoinAt[channelId] ?? 0;
  if (now - last < JOIN_DEBOUNCE_MS) {
    // Per-channel debounce (fixes single-slot collapse chA→chB→chC => only chC)
    pendingJoinIds.add(channelId);
    if (pendingJoinTimers[channelId]) clearTimeout(pendingJoinTimers[channelId]!);
    pendingJoinTimers[channelId] = setTimeout(() => {
      delete pendingJoinTimers[channelId];
      pendingJoinIds.delete(channelId);
      lastJoinAt[channelId] = Date.now();
      pruneJoinCache();
      try { socket.emit('channel:join' as any, { channelId }); } catch {}
    }, JOIN_DEBOUNCE_MS);
    return;
  }
  lastJoinAt[channelId] = now;
  pruneJoinCache();
  try { socket.emit('channel:join' as any, { channelId }); } catch {}
}

export function cleanupSocketJoins() {
  for (const t of Object.values(pendingJoinTimers)) clearTimeout(t as any);
  for (const k of Object.keys(pendingJoinTimers)) delete pendingJoinTimers[k];
  pendingJoinIds.clear();
}

socket.on('connect', () => {
  try {
    const active = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
    if (active) emitChannelJoin(active);
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

