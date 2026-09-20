// ─── Ephemeral vs durable event classification (§29) ───────────────────
// Which broker events earn a line in the local event log, and which are
// deliberately dropped.
//
// The retired `durable_events` path classified exactly one key as ephemeral:
//   const EPHEMERAL_EVENTS = new Set(["message:stream"]);
//   if (DURABLE_EVENTS_ENABLED && !EPHEMERAL_EVENTS.has(event.type)) { ...insert... }
// (pre-D6 `shared/sockets/register-socket-server.ts`). That single-key set is
// preserved verbatim below: it is the same rule the old PG log applied, minus
// the PG leg. `message:stream` is one event per token chunk per agent, so it is
// high-frequency, worthless to replay (the final `message:new` carries the same
// text), and would dominate the log's size within minutes.
//
// Everything else that carries a channelId is durable — including the
// `runtime:snapshot` / `workspace:*` shapes, which have no channelId and are
// therefore never logged at all (see `resolveEventChannelId`).

import type { BrokerEventType } from "../event-broker/event-broker-gate.js";

/** High-frequency, replay-worthless keys. Never written to the event log. */
export const EPHEMERAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>(["message:stream"]);

/** True when the event type is never persisted. */
export function isEphemeralEventType(type: string): boolean {
  return EPHEMERAL_EVENT_TYPES.has(type);
}

/**
 * Resolve the channel an event belongs to.
 *
 * Mirrors the retired dual-write rule exactly: the top-level `channelId` wins,
 * and the payload's `channelId` is the fallback for producers that only tag the
 * payload. Returns null when neither carries one — those events (global
 * snapshots, workspace-scoped syncs) are not channel history and are skipped.
 */
export function resolveEventChannelId(event: { channelId?: string; payload?: unknown }): string | null {
  const top = typeof event.channelId === "string" ? event.channelId.trim() : "";
  if (top) return top;
  const payloadChannelId = (event.payload as { channelId?: unknown } | null | undefined)?.channelId;
  if (typeof payloadChannelId === "string" && payloadChannelId.trim()) return payloadChannelId.trim();
  return null;
}

/** Owning workspace when the payload tags one (§30 scoping audit). */
export function resolveEventWorkspaceId(payload: unknown): string | null {
  const ws = (payload as { workspaceId?: unknown } | null | undefined)?.workspaceId;
  return typeof ws === "string" && ws.trim() ? ws.trim() : null;
}

/** Payload `agentId` when present — the client's optional `agentId` field. */
export function resolveEventAgentId(payload: unknown): string | null {
  const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
}

/**
 * Decide whether one broker event should be appended to the channel log.
 * Pure and side-effect free so the classification is unit-testable and the
 * emit hook stays a thin branch.
 */
export function shouldLogEvent(event: {
  type: BrokerEventType;
  channelId?: string;
  payload?: unknown;
}): boolean {
  if (isEphemeralEventType(event.type)) return false;
  return resolveEventChannelId(event) !== null;
}
