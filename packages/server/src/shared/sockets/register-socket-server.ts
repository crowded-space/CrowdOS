import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { eq } from "drizzle-orm";
import os from "node:os";
import { env } from "../config/env.js";

import { EventBroker } from "../../event-broker/event-broker-gate.js";
import { getSharedBroker, setSharedBroker } from "../../event-broker/event-broker-gate.js";
import { MentionParser } from "../core/mention-parser.js";
import { AgentRegistry } from "../../agents/agent-gate.js";
import { channelGate } from "../../channels/channel-gate.js";
import { messageGate } from "../../messages/message-gate.js";
import { isLoopbackPeer, resolveSocketIdentity } from "./socket-auth.js";
import type { SocketIdentity } from "./socket-auth.js";
import { createSocketRateLimiter } from "./rate-limiter.js";
import {
  channelRoom,
  workspaceRoom,
  isWorkspaceRoom,
  parseChannelRoom,
} from "./room-keys.js";
import { runtimeGate } from "../../runtime/runtime-gate.js";
import { composerModeToRuntime } from "../../runtime/types.js";
import { IndexBuilder } from "../core/index-builder.js";
import { getDb } from "../config/database.js";
import { startHeartbeatSystem } from "../core/agent-heartbeat.js";
import { agents, channels, categories, workspaces, runtimeOverrides } from "../../db/schema.js";
import { desc, gt, and, isNull, lt, sql } from "drizzle-orm";
import type {
  SocketClientToServerEvents,
  SocketServerToClientEvents,
  EventEnvelope,
  BrokerEventType,
} from "../../event-broker/event-broker-gate.js";
import type { AgentProfile } from "../../agents/agent-gate.js";
import { logMetric } from "../core/structured-log.js";
import { queueGate } from "../../queue/queue-gate.js";

const mentionParser = new MentionParser();
const agentRegistry = new AgentRegistry();
// Agent execution is routed through runtimeGate
export let globalBroker: EventBroker | null = null;

/**
 * CrowdOS §8 + §14: Librarian/Owl is never the default conversational agent.
 * It is heartbeat-oriented (10-min reindex) and only answers explicit mentions.
 */
function isLibrarianAgent(agent: { id: string; name: string }): boolean {
  if (agent.id === "agent-librarian") return true;
  const n = agent.name?.toLowerCase();
  return n === "owl" || n === "librarian";
}

/**
 * CrowdOS §10: multi-mention executes serially — B sees A's output via the
 * shared channel context committed before the next dispatch starts.
 * Each task is isolated (allSettled semantics) so one failure never
 * fails its siblings. MAX_PARALLEL_AGENTS is intentionally ignored.
 */
async function runBoundedBatch(
  tasks: ReadonlyArray<() => Promise<void>>,
  _limit?: number,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(tasks.length);
  for (let index = 0; index < tasks.length; index++) {
    try {
      await tasks[index]();
      results[index] = { status: "fulfilled", value: undefined };
    } catch (reason) {
      results[index] = { status: "rejected", reason };
    }
  }
  return results;
}

// Per-process handle on the active socket rate limiter (SEC-5 fold-in).
// Same-folder tests read it to verify disconnect cleanup; not a public API.
// CAN-1: activeRuns() snapshots the in-flight run registry for tests/diagnostics.
export const _socketsInternals: {
  limiter: ReturnType<typeof createSocketRateLimiter> | null;
  activeRuns: () => Array<{ key: string; controller: AbortController; startedAt: number }>;
} = {
  limiter: null,
  activeRuns: () =>
    Array.from(activeRuns.entries()).flatMap(([key, entries]) =>
      entries.map((entry) => ({ key, controller: entry.controller, startedAt: entry.startedAt })),
    ),
};

interface ActiveRunEntry {
  controller: AbortController;
  startedAt: number;
}

/**
 * In-flight run cancellation registry (HM2). Keyed `${channelId}:${agentId}`.
 * Aborting is user-initiated only (user:cancel event) — never on socket
 * disconnect, so background work survives browser closes.
 *
 * CAN-1: the value is an ARRAY of runs, not a single controller — a second
 * trigger for the same key no longer overwrites (and strands) the first
 * controller. Entries are removed when their run settles.
 */
const activeRuns = new Map<string, ActiveRunEntry[]>();

function runKey(channelId: string, agentId: string): string {
  return `${channelId}:${agentId}`;
}

/** Raised when a trigger arrives for a channel:agent pair that is already running. */
export class DuplicateRunError extends Error {
  readonly code = 'already_running' as const;

  constructor(agentName: string) {
    super(`@${agentName} is already running in this channel — previous request still in progress.`);
    this.name = 'DuplicateRunError';
  }
}

function beginRun(key: string, agentName: string): ActiveRunEntry {
  const queue = activeRuns.get(key);
  if (queue && queue.length > 0) throw new DuplicateRunError(agentName);
  const entry: ActiveRunEntry = { controller: new AbortController(), startedAt: Date.now() };
  activeRuns.set(key, [...(queue ?? []), entry]);
  return entry;
}

function endRun(key: string, entry: ActiveRunEntry): void {
  const queue = activeRuns.get(key);
  if (!queue) return;
  const next = queue.filter((e) => e !== entry);
  if (next.length > 0) activeRuns.set(key, next);
  else activeRuns.delete(key);
}

// Agent execution is handled by RuntimeExecutor

async function triggerSystemWarning(broker: EventBroker, channelId: string, content: string): Promise<void> {
  // Messages owns the table: sequence + insert + emit live in messageGate.append.
  await messageGate.append(
    {
      channelId,
      authorId: "system",
      authorName: "System Warning",
      authorLevel: "stakeholder",
      authorType: "system",
      content,
    },
    { broker }
  );
}

async function emitRuntimeSnapshot(target: any): Promise<void> {
  const t0 = performance.now();
  try {
    // C3 local-first, record-only DB: the snapshot unions each workspace's
    // record database (best-effort fan-out) with the local file tier, local
    // winning on id collision (same rule as mergeRoster). No env-pool read —
    // with zero record URLs this is pure local. Local files are always read
    // (dual-write keeps them mirroring PG), so the snapshot never depends on
    // a database being up.
    const { listWorkspaceRecords } = await import("../../workspace/workspace-gate.js");
    const { localListAgents } = await import("../../agents/agent-local-store.js");
    const records = await listWorkspaceRecords().catch(() => []);
    const roster = await localListAgents({}).catch(() => []);
    if (!records.some((w: any) => w.databaseUrl?.trim())) {
      const memUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      target.emit("runtime:snapshot", {
        workspaces: records.map((w: any) => ({
          id: w.id, name: w.name, ownerId: "system", status: "ACTIVE",
          rootPath: w.rootPath, permissions: {}, constraints: {},
          metadata: {}, createdAt: w.createdAt, updatedAt: w.updatedAt,
        })),
        agents: roster.map((ag: any) => ({
          id: ag.id, name: ag.name, title: ag.title, species: ag.species || "AI Assistant",
          avatar: ag.avatar || "🤖", authorityLevel: ag.authorityLevel,
          status: ag.status || "idle", instructionModuleId: ag.instructionModuleId,
          modelModuleId: ag.modelModuleId, toolkitModuleId: ag.toolkitModuleId,
          isOmniscient: ag.isOmniscient || false,
          createdAt: ag.createdAt, updatedAt: ag.updatedAt,
        })),
        swarms: [],
        escalations: [],
        sandboxes: records.map((w: any) => ({
          sandboxId: `sb-${w.id}`, workspaceId: w.id, status: "idle" as const,
          activeProcesses: [], memoryUsedMb: memUsedMb, cpuUsagePercent: 0,
          lastUpdated: new Date().toISOString(),
        })),
        overrides: [],
        runtimeHealth: { status: "healthy" as const, timestamp: new Date().toISOString() },
      });
      try { logMetric({ stage: 'snapshot.emit', durationMs: Math.round(performance.now() - t0) }); } catch {}
      return;
    }
    // Column projection: snapshot maps a fixed field set — never SELECT * the
    // full rows (agents/workspaces carry wide jsonb + secret-adjacent columns).
    const wsById = new Map<string, any>();
    const agById = new Map<string, any>();
    const ovById = new Map<string, any>();
    for (const rec of records) {
      if (!(rec as any).databaseUrl?.trim()) continue;
      try {
        const { getWorkspaceDb } = await import("../../workspace/workspace-gate.js");
        const { db } = await getWorkspaceDb(rec.id);
        const [wss, ags, ovs] = await Promise.all([
          db.query.workspaces.findMany({
            columns: { id: true, name: true, ownerId: true, status: true, rootPath: true, permissions: true, constraints: true, metadata: true, createdAt: true, updatedAt: true },
          }),
          db.query.agents.findMany({
            where: isNull(agents.archivedAt),
            columns: { id: true, name: true, title: true, species: true, avatar: true, authorityLevel: true, status: true, instructionModuleId: true, modelModuleId: true, toolkitModuleId: true, isOmniscient: true, createdAt: true, updatedAt: true },
          }),
          db.query.runtimeOverrides.findMany({
            columns: { id: true, targetAgentId: true, overrideType: true, instructionPatch: true, permissionPatch: true, createdBy: true, createdAt: true },
          }),
        ]);
        for (const w of wss) if (!wsById.has(w.id)) wsById.set(w.id, w);
        for (const a of ags) if (!agById.has(a.id)) agById.set(a.id, a);
        for (const o of ovs) if (!ovById.has(o.id)) ovById.set(o.id, o);
      } catch {
        // Dead database: the local tier below still represents the workspace.
      }
    }
    // Local tier overwrites on collision (local-first truth).
    for (const w of records) {
      wsById.set(w.id, {
        id: w.id, name: w.name, ownerId: "system", status: "ACTIVE",
        rootPath: w.rootPath, permissions: {}, constraints: {},
        metadata: {}, createdAt: new Date(w.createdAt), updatedAt: new Date(w.updatedAt),
      });
    }
    for (const ag of roster) {
      agById.set(ag.id, {
        ...ag,
        createdAt: new Date(ag.createdAt), updatedAt: new Date(ag.updatedAt),
      });
    }
    const dbWorkspaces = [...wsById.values()];
    const dbAgents = [...agById.values()];
    const dbOverrides = [...ovById.values()];

    // ponytail: legacy spawn_requests retired — Swarm gate owns DAG.
    const swarms: Array<{ swarmId: string; name: string; status: "active"; members: string[]; activeTasksCount: number; createdAt: string }> = [];

    // Real telemetry instead of hardcoded 42Mb (P0/P1 HQ5)
    const memUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const cpuUsage = process.cpuUsage();
    const cpuPercent = Math.min(100, Math.round((cpuUsage.user + cpuUsage.system) / 10000) / 10);

    const snapshot = {
      workspaces: dbWorkspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        ownerId: ws.ownerId,
        status: ws.status,
        rootPath: ws.rootPath,
        permissions: ws.permissions,
        constraints: ws.constraints,
        metadata: ws.metadata || {},
        createdAt: (ws.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: (ws.updatedAt as Date)?.toISOString?.() ?? new Date().toISOString(),
      })),
      agents: dbAgents.map(ag => ({
        id: ag.id,
        name: ag.name,
        title: ag.title,
        species: ag.species || "AI Assistant",
        avatar: ag.avatar || "🤖",
        authorityLevel: ag.authorityLevel,
        status: ag.status || "idle",
        instructionModuleId: ag.instructionModuleId,
        modelModuleId: ag.modelModuleId,
        toolkitModuleId: ag.toolkitModuleId,
        isOmniscient: ag.isOmniscient || false,
        createdAt: (ag.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: (ag.updatedAt as Date)?.toISOString?.() ?? new Date().toISOString(),
      })),
      swarms,
      escalations: [],
      sandboxes: dbWorkspaces.map(ws => ({
        sandboxId: `sb-${ws.id}`,
        workspaceId: ws.id,
        status: "idle" as const,
        activeProcesses: [],
        memoryUsedMb: memUsedMb,
        cpuUsagePercent: cpuPercent,
        lastUpdated: new Date().toISOString(),
      })),
      overrides: dbOverrides.map(ov => ({
        id: ov.id,
        agentId: ov.targetAgentId,
        type: ov.overrideType === "runtime_patch" ? "instruction" : "model",
        patch: (ov.instructionPatch || ov.permissionPatch || {}) as Record<string, any>,
        reason: ov.createdBy,
        active: true,
        createdAt: (ov.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
      })),
      runtimeHealth: {
        status: "healthy" as const,
        timestamp: new Date().toISOString(),
      },
    };

    target.emit("runtime:snapshot", snapshot);
    const dt = Math.round(performance.now() - t0);
    try { logMetric({ stage: 'snapshot.emit', durationMs: dt }); } catch {}
  } catch (err) {
    console.error("[registerSocketServer] Failed to emit runtime snapshot:", err);
  }
}

export type RunExecutor = typeof runtimeGate.execute;

export interface SocketServerDeps {
  /** Test seam (CAN-1): inject a stub run executor; defaults to runtimeGate.execute. */
  executeRun?: RunExecutor;
}

export function registerSocketServer(httpServer: HttpServer, broker: EventBroker, deps: SocketServerDeps = {}) {
  globalBroker = broker;
  setSharedBroker(broker);

  const executeRun: RunExecutor = deps.executeRun ?? ((req) => runtimeGate.execute(req));

  /**
   * Run a trigger with cancellation support (HM2/CAN-1). Registers the run's
   * AbortController under `${channelId}:${agentId}` — duplicate triggers for a
   * busy key throw DuplicateRunError instead of overwriting the live controller.
   */
  async function executeWithCancel(req: Parameters<RunExecutor>[0]): Promise<ReturnType<RunExecutor>> {
    const key = runKey(req.channelId, req.agent.id);
    const entry = beginRun(key, req.agent.name);
    try {
      return await executeRun({ ...req, abortSignal: entry.controller.signal });
    } finally {
      endRun(key, entry);
    }
  }

  const allowedOrigins = env.CLIENT_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

  const io = new Server<SocketClientToServerEvents, SocketServerToClientEvents>(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) { cb(null, true); return; }
        if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) { cb(null, true); return; }
        const isLocalhost = origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
        if (isLocalhost && allowedOrigins.some((o) => o.includes("localhost") || o.includes("127.0.0.1"))) {
          cb(null, true); return;
        }
        cb(new Error(`Socket CORS blocked: ${origin}`), false);
      },
      credentials: true,
    },
    // Enforce websocket origin via CORS above; do not allow arbitrary transports without auth
  });

  // SEC-2: per-socket token bucket for user-content events (see rateLimiter.ts).
  const messageLimiter = createSocketRateLimiter();
  _socketsInternals.limiter = messageLimiter;

  // SEC-2 handshake trust boundary: identity is derived server-side from the
  // credential in socket.handshake.auth (or Authorization/x-api-key header).
  // Keyless handshakes are accepted only from loopback peers (same-machine
  // single user — REST parity); the loopback identity is minted here, never
  // from client claims. Rejection here means the socket never reaches any
  // connection handler.
  io.use(async (socket, next) => {
    try {
      const keyed = await resolveSocketIdentity(socket.handshake as any);
      const identity: SocketIdentity | null =
        keyed ??
        (isLoopbackPeer(socket.handshake.address)
          ? { mode: "loopback", userId: "local-user", workspaceId: "default" }
          : null);
      if (!identity) {
        next(new Error("Unauthorized"));
        return;
      }
      socket.data.identity = identity;
      socket.data.userId = identity.userId;
      socket.data.workspaceId = identity.workspaceId;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error("Unauthorized"));
    }
  });

  // Room-scoped broadcast (P0-6): never io.emit globally for channel/workspace events.
  // D6: no durable_events dual-write. The per-message commit + sequence counter
  // (§29) is the event stream; catch-up is message refetch, not event replay.
  // §30: every room is workspace-namespaced (room-keys.ts) so two workspaces
  // sharing a channel id can never receive each other's events.

  /**
   * §30 fan-out helper: workspaces whose sockets currently observe a channel id.
   *
   * The authoritative answer is the live adapter itself: a channel room is
   * `ws:<workspaceId>:channel:<channelId>`, so scanning live rooms yields exactly
   * the scopes that have a member — and every one of them is already
   * workspace-scoped, so the result can never cross a workspace boundary.
   * Rooms disappear from the adapter when their last member disconnects, so this
   * needs no bookkeeping and cannot go stale.
   */
  const observedScopesForChannel = (channelId: string): string[] => {
    const scopes: string[] = [];
    for (const room of io.sockets.adapter.rooms.keys()) {
      const parsed = parseChannelRoom(room);
      if (parsed && parsed.channelId === channelId) scopes.push(parsed.workspaceId);
    }
    return scopes;
  };

  broker.onAny((event) => {
    const channelId = (event as any).channelId || (event.payload as any)?.channelId;
    const payloadWorkspaceId = (event.payload as any)?.workspaceId;

    // EVT-0: emit the full envelope — correlation fields at top level, payload nested
    const envelope: EventEnvelope = {
      eventId: event.eventId,
      seq: event.seq ?? null,
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
    };

    if (channelId) {
      // §30 scoping stays SYNCHRONOUS so event ordering is unchanged.
      // A socket only ever joins rooms of its OWN workspace, so every room
      // below is workspace-scoped by construction and cannot cross a boundary.
      // Scope resolution:
      //   1. payload workspaceId (message:new carries the message row's) —
      //      authoritative when present, because the producing domain knows
      //      which workspace the row belongs to;
      //   2. otherwise the live channel rooms for this channel id, which are
      //      exactly the scopes currently observing it.
      const scopes = payloadWorkspaceId ? [payloadWorkspaceId] : observedScopesForChannel(channelId);
      for (const workspaceId of scopes) {
        io.to(channelRoom(workspaceId, channelId)).emit(event.type, envelope as never);
      }
      // The workspace-room mirror keeps its exact previous semantics: only a
      // payload-tagged channel event reaches the workspace room, so a socket
      // that never joined the channel is not woken by its traffic (SEC-2).
      if (payloadWorkspaceId) io.to(workspaceRoom(payloadWorkspaceId)).emit(event.type, envelope as never);
      // SEC-2: the workspace:default mirror fan-out is gone — channel events are
      // delivered only to sockets that actually joined the channel/workspace room.
    } else if (payloadWorkspaceId) {
      io.to(workspaceRoom(payloadWorkspaceId)).emit(event.type, envelope as never);
    } else {
      // Global events (workspace:sync, runtime:snapshot, budget, escalation) fan
      // out to every live workspace room; empty rooms disappear from the adapter
      // automatically when their last member disconnects.
      for (const room of io.sockets.adapter.rooms.keys()) {
        if (isWorkspaceRoom(room)) io.to(room).emit(event.type, envelope as never);
      }
      // For fully global fallback, also emit but limited: only if CLIENT_ORIGIN is localhost (dev)
      if (allowedOrigins.includes("*") || allowedOrigins.some((o) => o.includes("localhost"))) {
        io.emit(event.type, envelope as never);
      }
    }
  });

  // Register permanent index count listener for all new messages!
  broker.on("message:new", undefined, async (event) => {
    try {
      const msg = event.payload;
      await IndexBuilder.incrementMessageCount(msg.channelId);
    } catch (err) {
      console.error("[EventBroker] Failed to increment channel message count:", err);
    }
  });

  // Setup periodic background indexing for stale channels (drift >= 10 messages) every 10 minutes
  const isBullMqMode = queueGate.mode() === "bullmq";
  if (!isBullMqMode) {
    setInterval(async () => {
      try {
        await IndexBuilder.reindexStaleChannels(broker);
      } catch (err) {
        console.error("[IndexBuilder] Background reindexing task failed:", err);
      }
    }, 10 * 60 * 1000);
  }

  // Periodic snapshot broadcast to prevent drift (every 15 seconds).
  // Skipped entirely when no clients are connected — avoids 4 full-table
  // queries per tick burning DB capacity in an idle server.
  // QUE-2: when bullmq mode, this local timer is replaced by the maintenance
  // repeatable `snapshot-full` (15s) so API does not burn DB while idle.
  if (!isBullMqMode) {
    const snapshotInterval = setInterval(() => {
      if (io.sockets.sockets.size > 0) {
        emitRuntimeSnapshot(io);
      }
    }, 15000);
    snapshotInterval.unref?.();
  }

  // Agent heartbeat toucher + zombie orphan sweeper (P0-4)
  // QUE-2: local timers skipped when bullmq repeatables cover them.
  if (!isBullMqMode) {
    startHeartbeatSystem(broker);
  }

  io.on("connection", (socket) => {
    // SEC-2: identity comes exclusively from the verified handshake middleware.
    // Client-supplied userId/workspaceId claims are ignored.
    const identity: SocketIdentity = socket.data.identity;

    // Auto-join the identity's own workspace scope room only. The unconditional
    // `workspace:default` mirror join was removed with the mirror fan-out (SEC-2).
    // §30: rooms are workspace-namespaced — `ws:<workspaceId>`.
    socket.join(workspaceRoom(identity.workspaceId));

    const deny = (code: string, message: string) => {
      console.warn(`[Socket] ${code}: ${message} (identity=${identity.userId})`);
      socket.emit("error" as any, { code, message });
    };

    // Server-side room admission checks (SEC-2). The schema has no per-user
    // channel membership/visibility model; the strongest real rule available is:
    // verified key identity + channel/workspace must exist server-side via gates.
    //
    // §30 adds the workspace boundary: the room key is derived from the
    // CHANNEL's owning workspace (server truth, never a client claim), and a
    // socket that declared a real workspace may only join channels of that
    // workspace. Legacy channels with no workspaceId are global by design
    // (migration 0018 convention) and stay joinable from any workspace; the
    // loopback/apikey identity's "default" is the unscoped single-user
    // placeholder used across this codebase ("?? default"), not a tenant.
    const DEFAULT_WORKSPACE_SCOPE = "default";

    /** Effective workspace of this socket (declared via workspace:join, else identity). */
    const socketWorkspace = (): string =>
      (socket.data as { workspaceId?: string }).workspaceId ?? identity.workspaceId ?? DEFAULT_WORKSPACE_SCOPE;

    /**
     * §30 channel-room admission. Returns the room to join, or a denial reason.
     *
     * The room key comes from the CHANNEL's owning workspace (server truth via
     * the gate, never a client claim). A socket whose effective workspace is a
     * real workspace may only join channels of that workspace. Legacy channels
     * with no workspaceId are global by design (migration 0018 convention) and
     * stay joinable; the "default" placeholder identity is the unscoped
     * single-user scope it already is everywhere else in this codebase.
     */
    const resolveChannelRoom = async (
      cid: string,
    ): Promise<{ room: string; workspaceId: string } | { deny: "channel_not_found" | "channel_forbidden" }> => {
      let row: unknown = null;
      try {
        row = await channelGate.get(cid);
      } catch {
        row = null;
      }
      if (!row) return { deny: "channel_not_found" };
      const rawWorkspaceId = (row as { workspaceId?: string | null }).workspaceId ?? null;
      const channelWorkspaceId = rawWorkspaceId ?? DEFAULT_WORKSPACE_SCOPE;
      const declared = socketWorkspace();
      if (rawWorkspaceId !== null && declared !== DEFAULT_WORKSPACE_SCOPE && declared !== rawWorkspaceId) {
        return { deny: "channel_forbidden" };
      }
      return { room: channelRoom(channelWorkspaceId, cid), workspaceId: channelWorkspaceId };
    };

    const canJoinWorkspaceRoom = async (wid: string): Promise<boolean> => {
      try {
        // C3 local-first: registry first (works without DATABASE_URL), DB second.
        const { getWorkspaceRecord } = await import("../../workspace/workspace-gate.js");
        if (await getWorkspaceRecord(wid).catch(() => null)) return true;
        const ws = await getDb().query.workspaces.findFirst({ where: eq(workspaces.id, wid) });
        return Boolean(ws);
      } catch {
        return false;
      }
    };

    // CAN-1 duplicate-trigger policy: a second trigger for an already-running
    // channel:agent pair is REJECTED with a system warning on the channel
    // (existing event vocabulary — same pattern as paused/offline agents), and
    // the in-flight run keeps its controller.
    const runOrReportBusy = async (req: Parameters<typeof executeWithCancel>[0]) => {
      try {
        return await executeWithCancel(req);
      } catch (err) {
        if (err instanceof DuplicateRunError) {
          console.log(`[Socket] Duplicate trigger rejected for @${req.agent.name} in #${req.channelId}`);
          await triggerSystemWarning(broker, req.channelId, err.message);
          return null;
        }
        throw err;
      }
    };

    // Explicit channel join handler for room-scoped broadcast.
    // §30: the room is `ws:<workspaceId>:channel:<channelId>` — the workspace
    // comes from the channel row, so the same channel id in two workspaces maps
    // to two distinct rooms and neither socket can observe the other.
    socket.on("channel:join" as any, async (data: any) => {
      const cid = typeof data === "string" ? data : data?.channelId;
      if (!cid || typeof cid !== "string") return;

      const resolved = await resolveChannelRoom(cid);
      if ("deny" in resolved) {
        deny(resolved.deny, resolved.deny === "channel_forbidden"
          ? `Channel ${cid} belongs to another workspace`
          : `Unknown or inaccessible channel ${cid}`);
        return;
      }
      socket.join(resolved.room);
      // D6: no server replay. Catch-up is message refetch
      // (GET /api/channels/:id/messages on setActiveChannel).
    });
    socket.on("workspace:join" as any, async (data: any) => {
      const wid = typeof data === "string" ? data : data?.workspaceId;
      if (!wid || typeof wid !== "string") return;

      if (!(await canJoinWorkspaceRoom(wid))) {
        deny("workspace_not_found", `Unknown or inaccessible workspace ${wid}`);
        return;
      }
      socket.join(workspaceRoom(wid));
      socket.data.workspaceId = wid;
    });
    // D1 switch teardown: client leaves rooms it no longer observes so
    // cross-workspace events stop arriving after enter/switch.
    // §30: leave uses the same namespaced keys as join. The channel scope is
    // derived from the channel row so a leave always targets the room the join
    // created; a failed lookup falls back to the socket's own workspace scope.
    socket.on("channel:leave" as any, async (data: any) => {
      const cid = typeof data === "string" ? data : data?.channelId;
      if (!cid || typeof cid !== "string") return;
      try {
        let row: unknown = null;
        try {
          row = await channelGate.get(cid);
        } catch {
          row = null;
        }
        const channelWorkspaceId =
          (row as { workspaceId?: string | null } | null)?.workspaceId || socketWorkspace();
        socket.leave(channelRoom(channelWorkspaceId, cid));
      } catch {}
    });
    socket.on("workspace:leave" as any, (data: any) => {
      const wid = typeof data === "string" ? data : data?.workspaceId;
      if (!wid || typeof wid !== "string") return;
      try { socket.leave(workspaceRoom(wid)); } catch {}
      if (socket.data.workspaceId === wid) socket.data.workspaceId = undefined;
    });

    // Immediately emit snapshot on connection (scoped to socket only)
    emitRuntimeSnapshot(socket);

    // User-initiated cancellation (HM2/CAN-1): abort in-flight runs for a
    // channel, optionally scoped to a single agent. Every active controller for
    // the key is aborted (the registry is array-safe), and the runtime layer
    // converts the abort into status 'cancelled' (no failure message persisted).
    socket.on("user:cancel", async (payload) => {
      const { channelId, agentId } = payload || ({} as any);
      if (!channelId) return;
      let cancelled = 0;
      for (const [key, entries] of [...activeRuns.entries()]) {
        const [runChannel, runAgent] = key.split(":");
        if (runChannel !== channelId) continue;
        if (agentId && runAgent !== agentId) continue;
        for (const entry of entries) {
          cancelled++;
          broker.emit("agent:status", { agentId: runAgent, status: "idle" }, { channelId });
          entry.controller.abort(new Error(`Run cancelled by user (channel=${channelId}).`));
        }
      }
      console.log(`[Socket] user:cancel in #${channelId}${agentId ? ` agent=${agentId}` : ""} — aborted ${cancelled} run(s)`);
    });

    socket.on("user:message", async (payload) => {
      // SEC-5 fold-in: token-bucket throttle on user-content-producing events.
      // Over-limit sends are dropped with a rate_limited error envelope.
      if (!messageLimiter.consume(socket.id)) {
        deny("rate_limited", "Message rate limit exceeded.");
        return;
      }

      const { channelId, content } = payload as any;
      const rawMode = (payload as any).mode ?? (payload as any).runtimeMode;
      let explicitRuntime = composerModeToRuntime(rawMode);
      if (explicitRuntime) {
        console.log(`[Router] Override->${explicitRuntime} (from mode="${rawMode}") in #${channelId}`);
      } else {
        // §6 pinned runtime: an unset/temporary mode falls back to the
        // channel pin before Auto. A failed settings read means Auto.
        const settings = channelId && typeof channelId === "string"
          ? await channelGate.getSettings(channelId).catch(() => null)
          : null;
        const pinned = (settings as any)?.pinnedRuntime;
        if (typeof pinned === "string" && composerModeToRuntime(pinned)) {
          explicitRuntime = composerModeToRuntime(pinned);
          console.log(`[Router] Pinned->${explicitRuntime} in #${channelId}`);
        } else {
          console.log(`[Router] Auto mode selected for message in #${channelId}`);
        }
      }

      // Owning channel row once per message: admission + workspace stamping +
      // default-target resolution share it (was 3 duplicate lookups).
      const msgChannel = channelId && typeof channelId === "string"
        ? await channelGate.get(channelId).catch(() => null)
        : null;
      // Workspace stamp for runs/agent rows (message rows resolve it via gate).
      const msgWorkspaceId =
        msgChannel?.workspaceId ?? (socket.data as any)?.workspaceId ?? "default";

      // Auto-join the target channel so the sender receives scoped events —
      // only after the same §30 workspace-scoped admission check as channel:join.
      if (msgChannel) {
        const autoJoinWorkspaceId = msgChannel.workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
        socket.join(channelRoom(autoJoinWorkspaceId, channelId));
      }

      try {
        // 1. Resolve and parse mentions from content
        const resolvedMentions = await mentionParser.parseMentions(content);

        // 2. Persist the human operator's message — author identity is the
        // server-verified key identity; client authorId/authorName claims are
        // advisory only and never persisted (SEC-2). Messages owns the table.
        const authorId = identity.userId;
        const authorName = identity.mode === "apikey"
          ? (identity.label || identity.keyId || authorId)
          : ((payload as any).authorName || (authorId === "user-1" ? "Juan Hamzah" : authorId));

        const userMsg = await messageGate.append(
          {
            channelId,
            authorId,
            authorName,
            authorLevel: "stakeholder",
            authorType: "user",
            content,
            mentions: resolvedMentions,
          },
          { broker }
        );

        // 3. Process mentions and triggers
        const allAgents = await agentRegistry.list({ isTemplate: false });

        console.log(`[Socket] user:message received in channel ${channelId}: "${content}" (resolved mentions: ${resolvedMentions.length})`);

        // One shared per-agent dispatch body (§10 serial). Status gating, busy
        // rejection (via runOrReportBusy), cancellation/failed handling and
        // error isolation are identical for explicit mentions, role mentions
        // and auto-triggered agents. Sequence numbers are allocated at persist
        // time inside triggerSystemWarning / the runtime layer (DB-2).
        const dispatchAgent = async (agent: AgentProfile, announce: string): Promise<void> => {
          if (agent.status === "paused") {
            await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently paused.`);
            return;
          }
          if (agent.status === "offline") {
            await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently offline.`);
            return;
          }
          console.log(announce);
          let res: Awaited<ReturnType<typeof runOrReportBusy>>;
          try {
            res = await runOrReportBusy({
              agent,
              channelId,
              workspaceId: msgWorkspaceId,
              userInput: content,
              broker,
              explicitRuntime,
              librarianAgentId: 'agent-librarian',
            });
          } catch (err: any) {
            console.error(`[Socket] Execution failed for agent @${agent.name}:`, err?.message || err);
            await triggerSystemWarning(broker, channelId, `System error processing @${agent.name}: ${err?.message || err}`);
            return;
          }
          if (!res) return;
          if (res.status === 'cancelled') {
            console.log(`[Socket] Run cancelled for agent @${agent.name}`);
          } else if (res.status === 'failed') {
            console.error(`[Socket] Execution failed for agent @${agent.name}:`, res.finalResponse);
            await triggerSystemWarning(broker, channelId, res.finalResponse);
          }
        };

        const isQueueModeBullMq = queueGate.mode() === "bullmq" && process.env.NODE_ENV !== "test";

        // Default-agent resolution (§7 pinned mention, then §8 hierarchy,
        // Librarian never default). C3 local-first: gates branch to files
        // when no DATABASE_URL. Only live (non-paused/offline) agents serve.
        const resolveDefaultTargets = async (): Promise<typeof allAgents> => {
          const targetAgents: typeof allAgents = [];
          const live = (id: string | null | undefined) => {
            const agent = id ? allAgents.find(a => a.id === id) : undefined;
            return agent && !isLibrarianAgent(agent) && agent.status !== "offline" && agent.status !== "paused" ? agent : undefined;
          };
          const settings = await channelGate.getSettings(channelId).catch(() => null);
          const pinnedAgent = live((settings as any)?.activeAgentId);
          if (pinnedAgent) {
            targetAgents.push(pinnedAgent);
            return targetAgents;
          }
          const channelDefault = live((settings as any)?.defaultAgentId);
          if (channelDefault) {
            targetAgents.push(channelDefault);
            return targetAgents;
          }
          const channel = msgChannel;
          if (channel?.categoryId) {
            const category = await channelGate.getCategory(channel.categoryId).catch(() => null);
            if (category?.ownedByAgentId) {
              const ownerAgent = allAgents.find(a => a.id === category.ownedByAgentId);
              if (ownerAgent && !isLibrarianAgent(ownerAgent) && ownerAgent.status !== "offline" && ownerAgent.status !== "paused") {
                targetAgents.push(ownerAgent);
              }
            }
          }
          if (targetAgents.length === 0) {
            const l0Agents = allAgents.filter(a => !isLibrarianAgent(a) && a.authorityLevel === 0 && a.status !== "offline" && a.status !== "paused");
            if (l0Agents.length > 0) targetAgents.push(...l0Agents);
          }
          if (targetAgents.length === 0) {
            const defaultAgent = allAgents.find(a => !isLibrarianAgent(a) && a.name === "default-assistant" && a.status !== "offline" && a.status !== "paused")
              || allAgents.find(a => !isLibrarianAgent(a) && (a.status === "idle" || a.status === "working"));
            if (defaultAgent) targetAgents.push(defaultAgent);
          }
          return targetAgents;
        };

        if (isQueueModeBullMq) {
          const agentsToEnqueue: typeof allAgents = [];
          if (resolvedMentions.length > 0) {
            for (const mention of resolvedMentions) {
              if (mention.type === "agent") {
                const agent = allAgents.find(a => a.id === mention.targetId);
                if (agent) agentsToEnqueue.push(agent);
              } else if (mention.type === "role") {
                const levelStr = mention.targetId.replace("role-l", "");
                const levelNum = parseInt(levelStr, 10);
                if (!isNaN(levelNum)) {
                  const matchingAgents = allAgents.filter(a => a.authorityLevel === levelNum);
                  for (const agent of matchingAgents) agentsToEnqueue.push(agent);
                }
              }
            }
          } else {
            for (const agent of await resolveDefaultTargets()) agentsToEnqueue.push(agent);
          }

          // Pre-filter paused/offline, then serial enqueue per §10.
          const enqueueTasks: Array<() => Promise<void>> = [];
          for (const agent of agentsToEnqueue) {
            if (agent.status === "paused") {
              enqueueTasks.push(async () => { await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently paused.`); });
              continue;
            }
            if (agent.status === "offline") {
              enqueueTasks.push(async () => { await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently offline.`); });
              continue;
            }
            enqueueTasks.push(async () => {
              try {
                // H4: persist first so the queued job + run.queued carry the real DB UUID.
                // P06: never enqueue a provisional id — it can never match a DB row,
                // so the executor would openRun() a phantom row per attempt (x3 retries).
                // If persist fails (runs disabled / DB down), skip enqueue.
                const { runsGate } = await import("../../runs/runs-gate.js");
                const persisted = await runsGate.create({ agentId: agent.id, channelId, workspaceId: msgWorkspaceId, runtimeType: explicitRuntime ?? "agentic" }).catch(() => null);
                if (!persisted?.id) {
                  await triggerSystemWarning(broker, channelId, `System error queueing @${agent.name}: could not persist run.`);
                  return;
                }
                const runId = persisted.id;
                await queueGate.enqueueRun({
                  runId,
                  channelId,
                  agentId: agent.id,
                  messageId: userMsg.id,
                  userInput: content,
                  workspaceId: msgWorkspaceId,
                  explicitRuntime: explicitRuntime ?? null,
                });
                broker.emit("run.queued" as never, { runId, channelId, agentId: agent.id } as never, { channelId });
                console.log(`[Socket][Queue] Enqueued run ${runId} for @${agent.name} in #${channelId} (msg ${userMsg.id})`);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[Socket][Queue] Failed to enqueue agent @${agent.name}:`, msg);
                await triggerSystemWarning(broker, channelId, `System error queueing @${agent.name}: ${msg}`);
              }
            });
          }
          await runBoundedBatch(enqueueTasks);
        } else {
          const batch: Array<() => Promise<void>> = [];

          if (resolvedMentions.length > 0) {
            for (const mention of resolvedMentions) {
              if (mention.type === "agent") {
                const agent = allAgents.find(a => a.id === mention.targetId);
                if (agent) {
                  batch.push(() =>
                    dispatchAgent(agent, `[Socket] Triggering mentioned agent @${agent.name} (${agent.id})...`),
                  );
                }
              } else if (mention.type === "role") {
                const levelStr = mention.targetId.replace("role-l", "");
                const levelNum = parseInt(levelStr, 10);
                if (!isNaN(levelNum)) {
                  const matchingAgents = allAgents.filter(a => a.authorityLevel === levelNum);
                  for (const agent of matchingAgents) {
                    batch.push(() =>
                      dispatchAgent(agent, `[Socket] Triggering role agent @${agent.name} (L${agent.authorityLevel})...`),
                    );
                  }
                }
              }
            }
          } else {
            for (const agent of await resolveDefaultTargets()) {
              batch.push(() =>
                dispatchAgent(
                  agent,
                  `[Socket] Auto-triggering agent @${agent.name} for unmentioned message in #${msgChannel?.name || channelId}...`,
                ),
              );
            }
          }

          if (batch.length > 0) {
            const batchStartedAt = Date.now();
            await runBoundedBatch(batch);
            logMetric({
              stage: "mention.dispatch",
              durationMs: Date.now() - batchStartedAt,
              agents: batch.length,
              parallel: 1,
            });
          }
        }
      } catch (error: any) {
        console.error("Error in user:message handler:", error);
        await triggerSystemWarning(broker, channelId, `System error processing message: ${error?.message || error}`);
      }
    });

    socket.on("run:resume" as any, async (payload: any) => {
      const runId = payload?.runId;
      if (!runId || typeof runId !== "string") {
        socket.emit("error" as any, { code: "invalid_run_id", message: "runId required" });
        return;
      }
      if (identity.mode === "apikey") {
        const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
        const need = 2;
        const have = rank[identity.role ?? "viewer"] ?? 0;
        if (have < need) {
          socket.emit("error" as any, { code: "forbidden", message: "Requires operator role." });
          return;
        }
      }
      try {
        const { runsGate } = await import("../../runs/runs-gate.js");
        const result = await runsGate.resumeRun(runId);
        if (!result) {
          socket.emit("error" as any, { code: "not_resumable", message: `run ${runId} not resumable` });
          return;
        }
        const { run, checkpoint } = result;
        const resumeContext = checkpoint ? { watermarkSeq: checkpoint.watermarkSeq, completedCallIds: checkpoint.completedCallIds, historyRef: checkpoint.historyRef, updatedAt: checkpoint.updatedAt } : { watermarkSeq: 0, completedCallIds: [] as string[] };
        const queueMode = queueGate.mode();
        if (queueMode === "bullmq") {
          const messageId = `resume:${run.id}:${Date.now()}`;
          await queueGate.enqueueRun({
            runId: run.id,
            channelId: run.channelId,
            agentId: run.agentId,
            messageId,
            userInput: "",
            workspaceId: run.workspaceId ?? undefined,
            // @ts-ignore
            resumeContext,
            // @ts-ignore
            resumeFrom: checkpoint,
          } as unknown as never);
          socket.emit("run:resume:ok" as any, { runId: run.id, status: run.status, resumeFrom: checkpoint });
        } else {
          const { runtimeGate } = await import("../../runtime/runtime-gate.js");
          const { agentGate } = await import("../../agents/agent-gate.js");
          // Shared instance: runtime emits fan out + persist via the bridge above.
          const broker = globalBroker ?? getSharedBroker();
          if (!broker) {
            socket.emit("error" as any, { code: "broker_unavailable", message: "EventBroker not initialized." });
            return;
          }
          let agent: unknown = null;
          try {
            if (typeof (agentGate as unknown as Record<string, unknown>).getById === "function") {
              agent = await (agentGate as unknown as { getById: (id: string) => Promise<unknown> }).getById(run.agentId);
            }
          } catch {}
          if (!agent) {
            try {
              const list = await (agentGate as unknown as { list: () => Promise<unknown[]> }).list();
              agent = (list as Array<{ id: string }>).find((a) => a.id === run.agentId) ?? null;
            } catch {}
          }
          if (!agent) {
            socket.emit("error" as any, { code: "agent_not_found", message: `agent ${run.agentId} not found` });
            return;
          }
          socket.emit("run:resume:ok" as any, { runId: run.id, status: run.status });
          void (runtimeGate as unknown as { execute: (req: unknown) => Promise<unknown> }).execute({
            agent,
            channelId: run.channelId,
            workspaceId: run.workspaceId ?? "default",
            userInput: "",
            broker,
            runId: run.id,
            resumeContext,
          });
        }
      } catch (err) {
        console.error("[Socket] run:resume failed:", err);
        socket.emit("error" as any, { code: "resume_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });

    socket.on("run:compensations:list" as any, async (payload: any) => {
      const runId = payload?.runId;
      if (!runId || typeof runId !== "string") return;
      if (identity.mode === "apikey") {
        const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
        if ((rank[identity.role ?? "viewer"] ?? 0) < 3) {
          socket.emit("error" as any, { code: "forbidden", message: "Requires admin role." });
          return;
        }
      }
      try {
        const { runsGate } = await import("../../runs/runs-gate.js");
        const entries = await runsGate.listCompensations(runId);
        // Shared instance (in scope): a fresh broker would reach no subscriber.
        if (globalBroker) {
          globalBroker.emit("run.compensations" as never, { runId, entries: entries.map(e => ({ id: e.id, seq: e.seq, toolName: e.toolName, targetPath: e.targetPath, inverseOp: e.inverseOp as unknown as { op: string; path: string }, createdAt: e.createdAt.toISOString() })) } as never, { channelId: (await runsGate.getById(runId))?.channelId } as never);
        } else {
          console.warn("[Socket] dropped run.compensations: no shared broker registered");
        }
        socket.emit("run:compensations" as any, { runId, entries });
      } catch (err) {
        console.error("[Socket] run:compensations:list failed:", err);
      }
    });

    socket.on("run:compensation:undo" as any, async (payload: any) => {
      const { runId, compId } = payload || {};
      if (!runId || !compId) {
        socket.emit("error" as any, { code: "invalid_compensation", message: "runId and compId required" });
        return;
      }
      if (identity.mode === "apikey") {
        const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
        if ((rank[identity.role ?? "viewer"] ?? 0) < 3) {
          socket.emit("error" as any, { code: "forbidden", message: "Requires admin role." });
          return;
        }
      }
      try {
        const { runsGate } = await import("../../runs/runs-gate.js");
        const result = await runsGate.undoCompensation(runId, compId);
        if (!result.ok) {
          socket.emit("error" as any, { code: "undo_failed", message: result.error });
          return;
        }
        const entries = await runsGate.listCompensations(runId);
        socket.emit("run:compensations" as any, { runId, entries });
        // Shared instance (in scope): a fresh broker would reach no subscriber.
        if (globalBroker) {
          const run = await runsGate.getById(runId);
          globalBroker.emit("run.compensations" as never, { runId, entries: entries.map(e => ({ id: e.id, seq: e.seq, toolName: e.toolName, targetPath: e.targetPath, inverseOp: e.inverseOp as unknown as { op: string; path: string }, createdAt: e.createdAt.toISOString() })) } as never, { channelId: run?.channelId } as never);
        } else {
          console.warn("[Socket] dropped run.compensations: no shared broker registered");
        }
      } catch (err) {
        console.error("[Socket] run:compensation:undo failed:", err);
        socket.emit("error" as any, { code: "undo_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });

    // APR-1 approval decision via socket (mirrors REST POST /api/approvals/:id/decision)
    socket.on("approval:decide" as any, async (payload: any) => {
      const { approvalId, decision, scope } = payload || {};
      if (!approvalId || (decision !== "approved" && decision !== "denied")) {
        socket.emit("error" as any, { code: "invalid_approval_decision", message: "approvalId and decision (approved|denied) required" });
        return;
      }
      if (identity.mode === "apikey") {
        const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
        if ((rank[identity.role ?? "viewer"] ?? 0) < 2) {
          socket.emit("error" as any, { code: "forbidden", message: "Requires operator role." });
          return;
        }
      }
      try {
        const { approvalGate, emitDecided } = await import("../../approvals/approval-gate.js");
        const existing = await approvalGate.getById(approvalId);
        if (!existing) {
          socket.emit("error" as any, { code: "not_found", message: `approval ${approvalId} not found` });
          return;
        }
        if (existing.status !== "pending") {
          socket.emit("error" as any, { code: "already_decided", message: `approval already ${existing.status}` });
          return;
        }
        const decidedBy = identity.mode === "apikey" ? `apikey:${identity.keyId}` : identity.userId;
        const updated = await approvalGate.decide(approvalId, { decision, decidedBy, scope: scope ?? null });
        if (!updated) {
          socket.emit("error" as any, { code: "decision_failed", message: "decision failed (concurrent update?)" });
          return;
        }
        // Emit approval.decided for timeline observers
        let channelIdForRun: string | undefined;
        try {
          const { runsGate } = await import("../../runs/runs-gate.js");
          const run = await runsGate.getById(updated.runId);
          channelIdForRun = run?.channelId;
          emitDecided(broker, {
            runId: updated.runId,
            approvalId: updated.id,
            tool: updated.toolName,
            decision,
            decidedBy,
            scope: updated.scope,
            riskClass: updated.riskClass,
            channelId: channelIdForRun,
          });
        } catch {}
        // APR-1: ensure run resumes even if no live poller (orphaned). Poller also transitions, so idempotent.
        try {
          const { runsGate } = await import("../../runs/runs-gate.js");
          const run = await runsGate.getById(updated.runId);
          if (run?.status === "waiting_for_approval") {
            await runsGate.transition(updated.runId, "running", `approval_${decision}`);
          }
        } catch {}
        socket.emit("approval:decided" as any, { approvalId: updated.id, decision, status: updated.status });
      } catch (err) {
        console.error("[Socket] approval:decide failed:", err);
        socket.emit("error" as any, { code: "approval_decide_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });

    socket.on("approval:list" as any, async (payload: any) => {
      const runId = payload?.runId;
      if (!runId || typeof runId !== "string") {
        socket.emit("error" as any, { code: "invalid_run_id", message: "runId required" });
        return;
      }
      if (identity.mode === "apikey") {
        const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
        if ((rank[identity.role ?? "viewer"] ?? 0) < 1) {
          socket.emit("error" as any, { code: "forbidden", message: "Requires viewer role." });
          return;
        }
      }
      try {
        const { approvalGate } = await import("../../approvals/approval-gate.js");
        const rows = await approvalGate.listByRun(runId);
        socket.emit("approval:list:result" as any, { runId, approvals: rows });
      } catch (err) {
        console.error("[Socket] approval:list failed:", err);
        socket.emit("error" as any, { code: "approval_list_failed", message: err instanceof Error ? err.message : String(err) });
      }
    });

    // SEC-2 disconnect handler: release the socket from every room it joined
    // and drop its per-socket bookkeeping. Product rule (HM2) — running
    // executions are deliberately NOT cancelled here: activeRuns is keyed by
    // channel:agent (not socket), entries are removed by executeWithCancel when
    // the run completes or a user:cancel aborts it. Background runs survive
    // browser closes by design; there are no typing/presence maps in this file.
    socket.on("disconnect", () => {
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }
      messageLimiter.release(socket.id);
      console.log(`[Socket] disconnected ${identity.userId} (${socket.id}); rooms released, in-flight runs left untouched`);
    });
  });

  return io;
}
