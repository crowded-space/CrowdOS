import { io } from "socket.io-client";

export const socket = io({
  path: '/socket.io',
  autoConnect: true,
  withCredentials: true,
  transports: ["websocket", "polling"]
});

const lastJoinAt: Record<string, number> = {};
let pendingJoinTimer: ReturnType<typeof setTimeout> | null = null;
let pendingJoinChannelId: string | null = null;
const JOIN_DEBOUNCE_MS = 400;

export function emitChannelJoin(channelId: string) {
  if (!channelId) return;
  const now = Date.now();
  const last = lastJoinAt[channelId] ?? 0;
  if (now - last < JOIN_DEBOUNCE_MS) {
    pendingJoinChannelId = channelId;
    if (pendingJoinTimer) clearTimeout(pendingJoinTimer);
    pendingJoinTimer = setTimeout(() => {
      if (pendingJoinChannelId) {
        lastJoinAt[pendingJoinChannelId] = Date.now();
        socket.emit('channel:join' as any, { channelId: pendingJoinChannelId });
        pendingJoinChannelId = null;
      }
      pendingJoinTimer = null;
    }, JOIN_DEBOUNCE_MS);
    return;
  }
  lastJoinAt[channelId] = now;
  socket.emit('channel:join' as any, { channelId });
}

socket.on('connect', () => {
  try {
    const active = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
    if (active) emitChannelJoin(active);
  } catch {}
});
