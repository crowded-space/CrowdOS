/**
 * Socket room key scheme (CrowdOS §30 workspace isolation).
 *
 * Rooms are namespaced by workspace so two workspaces that share a channel id
 * (e.g. a per-workspace "ch-general") can never receive each other's events:
 *
 *   workspace room : ws:<workspaceId>
 *   channel room   : ws:<workspaceId>:channel:<channelId>
 *
 * ONE scheme, used by every producer (io.to) and consumer (socket.join/leave)
 * in register-socket-server.ts and by the room-prefix scan that fans global
 * events out to live workspace rooms. The previous bare `channel:<id>` rooms
 * were shared across workspace databases for same-id channels, which made the
 * client-side isForeignWorkspacePayload filter the de-facto isolation defence.
 * Server-side room scoping is now the primary defence; the client filter is
 * defence-in-depth only.
 */

/** Prefix of every socket room owned by this scheme. */
export const ROOM_PREFIX = "ws:";

/** Room every socket of one workspace auto-joins: `ws:<workspaceId>`. */
export function workspaceRoom(workspaceId: string): string {
  return ROOM_PREFIX + workspaceId;
}

/** Channel room: `ws:<workspaceId>:channel:<channelId>`. */
export function channelRoom(workspaceId: string, channelId: string): string {
  return ROOM_PREFIX + workspaceId + ":channel:" + channelId;
}

/** True for the workspace-room shape (`ws:<id>`, no `:channel:` segment). */
export function isWorkspaceRoom(room: string): boolean {
  return room.startsWith(ROOM_PREFIX) && !room.includes(":channel:");
}

/** True for the channel-room shape (`ws:<id>:channel:<id>`). */
export function isChannelRoom(room: string): boolean {
  return room.startsWith(ROOM_PREFIX) && room.includes(":channel:");
}

/**
 * Parse a channel room back into its parts, or null when the room does not
 * match the scheme. Used by diagnostics/tests to assert scoping.
 */
export function parseChannelRoom(room: string): { workspaceId: string; channelId: string } | null {
  if (!room.startsWith(ROOM_PREFIX)) return null;
  const rest = room.slice(ROOM_PREFIX.length);
  const sep = rest.indexOf(":channel:");
  if (sep <= 0) return null;
  const workspaceId = rest.slice(0, sep);
  const channelId = rest.slice(sep + ":channel:".length);
  if (!workspaceId || !channelId) return null;
  return { workspaceId, channelId };
}

