import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { eq } from "drizzle-orm";
import os from "node:os";
import { env } from "../config/env.js";

import { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { MentionParser } from "../core/mentionParser.js";
import { AgentRegistry } from "../../Agents/agentGate.js";
import { channelGate } from "../../Channels/channelGate.js";
import { resolveSocketIdentity } from "./socketAuth.js";
import type { SocketIdentity } from "./socketAuth.js";
import { createSocketRateLimiter } from "./rateLimiter.js";
import { runtimeGate } from "../../runtime/runtimeGate.js";
import { composerModeToRuntime } from "../../runtime/types.js";
import { IndexBuilder } from "../core/indexBuilder.js";
import { getDb, withTransaction } from "../config/database.js";
import { startHeartbeatSystem } from "../core/agentHeartbeat.js";
import { messages, agents, channels, categories, workspaces, runtimeOverrides, spawnRequests, durableEvents } from "../../db/schema.js";
import { desc, gt, and, isNull, lt } from "drizzle-orm";
import type {
  SocketClientToServerEvents,
  SocketServerToClientEvents,
  EventEnvelope,
  BrokerEventType,
} from "../../EventBroker/eventBrokerGate.js";
import type { ChannelMessage } from "../../Messages/messageGate.js";
import type { AgentProfile } from "../../Agents/agentGate.js";
import { allocateSequence } from "../core/sequenceNumber.js";
import { monotonicUlid } from "../core/ulid.js";
import { logMetric } from "../core/structuredLog.js";
import { queueGate } from "../../Queue/queueGate.js";

const mentionParser = new MentionParser();
const agentRegistry = new AgentRegistry();
// Agent execution is routed through runtimeGate
export let globalBroker: EventBroker | null = null;

const DEFAULT_MAX_PARALLEL_AGENTS = 4;

function resolveMaxParallelAgents(): number {
  const raw = process.env.MAX_PARALLEL_AGENTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_PARALLEL_AGENTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PARALLEL_AGENTS;
  return Math.max(1, Math.floor(parsed));
}

/**
 * PERF-1: bounded worker pool over matched agents. Each task is an independent
 * per-agent dispatch; a rejection is isolated to its own slot (allSettled
 * semantics) so one failing agent never fails its siblings. limit=1 reproduces
 * the legacy serial for…await behavior exactly (rollback path).
 */
async function runBoundedBatch(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(tasks.length);
  if (tasks.length === 0) return results;
  const width = Math.max(1, Math.min(limit, tasks.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        await tasks[index]();
        results[index] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.allSettled(runners);
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
  // DB-2: reservation + insert commit atomically (no SELECT-MAX+1 race).
  const warningMsg = await withTransaction(async (tx) => {
    const sequenceNumber = await allocateSequence(channelId, 1, tx);
    const msg: ChannelMessage = {
      id: monotonicUlid(),
      channelId,
      authorId: "system",
      authorName: "System Warning",
      authorLevel: "stakeholder",
      authorType: "system",
      content,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber,
      timestamp: new Date(),
    };
    await tx.insert(messages).values({
      ...msg,
      authorLevel: String(msg.authorLevel),
    });
    return msg;
  });

  broker.emit("message:new", warningMsg, { channelId });
}

async function emitRuntimeSnapshot(target: any): Promise<void> {
  const t0 = performance.now();
  try {
    const db = getDb();
    const [dbWorkspaces, dbAgents, dbOverrides, activeSpawns] = await Promise.all([
      db.query.workspaces.findMany(),
      db.query.agents.findMany({ where: isNull(agents.archivedAt) }),
      db.query.runtimeOverrides.findMany(),
      db.query.spawnRequests.findMany({ where: (table, { eq }) => eq(table.status, "in_progress") }),
    ]);

    const swarms = activeSpawns.map(spawn => ({
      swarmId: spawn.id,
      name: `Swarm ${spawn.id.slice(0, 8)}`,
      status: "active" as const,
      members: [spawn.requestedBy, spawn.workerTemplateId, spawn.supervisorTemplateId].filter(Boolean),
      activeTasksCount: spawn.subtasks ? (spawn.subtasks as any[]).length : 0,
      createdAt: (spawn.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
    }));

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
  // Rejection here means the socket never reaches any connection handler.
  io.use(async (socket, next) => {
    try {
      const identity = await resolveSocketIdentity(socket.handshake as any);
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
  // Durable dual-write (HM3): non-ephemeral events are persisted to durable_events
  // (fire-and-forget — persistence failure must never block or break live delivery).
  const EPHEMERAL_EVENTS = new Set(["message:stream"]);
  const DURABLE_EVENTS_ENABLED = process.env.DURABLE_EVENTS !== "false";

  broker.onAny((event) => {
    const channelId = (event as any).channelId || (event.payload as any)?.channelId;
    const workspaceId = (event.payload as any)?.workspaceId;

    // EVT-0: emit the full envelope — correlation fields at top level, payload nested
    const envelope: EventEnvelope = {
      eventId: event.eventId,
      seq: event.seq ?? null,
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
    };

    if (DURABLE_EVENTS_ENABLED && !EPHEMERAL_EVENTS.has(event.type)) {
      void getDb().insert(durableEvents).values({
        eventId: event.eventId,
        type: event.type,
        channelId: channelId ?? null,
        agentId: (event.payload as any)?.agentId ?? null,
        payload: event.payload as Record<string, unknown>,
      }).catch((err) => {
        console.error("[EventBroker] Failed to persist durable event:", err?.message || err);
      });
    }

    if (channelId) {
      io.to(`channel:${channelId}`).emit(event.type, envelope as never);
      // Also emit to workspace room for cross-channel workspace observers
      if (workspaceId) io.to(`workspace:${workspaceId}`).emit(event.type, envelope as never);
      // SEC-2: the workspace:default mirror fan-out is gone — channel events are
      // delivered only to sockets that actually joined the channel/workspace room.
    } else if (workspaceId) {
      io.to(`workspace:${workspaceId}`).emit(event.type, envelope as never);
    } else {
      // Global events (workspace:sync, runtime:snapshot, budget, escalation) fan
      // out to every live workspace room; empty rooms disappear from the adapter
      // automatically when their last member disconnects.
      for (const room of io.sockets.adapter.rooms.keys()) {
        if (room.startsWith("workspace:")) io.to(room).emit(event.type, envelope as never);
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

  // Durable event retention: drop entries older than 24h, checked hourly
  if (!isBullMqMode) {
    const retentionInterval = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await getDb().delete(durableEvents).where(lt(durableEvents.createdAt, cutoff));
      } catch (err: any) {
        console.error("[EventBroker] Durable event retention cleanup failed:", err?.message || err);
      }
    }, 60 * 60 * 1000);
    retentionInterval.unref?.();
  }

  // Agent heartbeat toucher + zombie orphan sweeper (P0-4)
  // QUE-2: local timers skipped when bullmq repeatables cover them.
  if (!isBullMqMode) {
    startHeartbeatSystem(broker);
  }

  io.on("connection", (socket) => {
    // SEC-2: identity comes exclusively from the verified handshake middleware.
    // Client-supplied userId/workspaceId claims are advisory and ignored outside
    // SOCKET_OPEN rollback mode.
    const identity: SocketIdentity = socket.data.identity;

    // Auto-join the identity's own workspace scope room only. The unconditional
    // `workspace:default` mirror join was removed with the mirror fan-out (SEC-2).
    socket.join(`workspace:${identity.workspaceId}`);

    const deny = (code: string, message: string) => {
      console.warn(`[Socket] ${code}: ${message} (identity=${identity.userId})`);
      socket.emit("error" as any, { code, message });
    };

    // Server-side room admission checks (SEC-2). The schema has no per-user
    // channel membership/visibility model; the strongest real rule available is:
    // verified key identity + channel/workspace must exist server-side via gates.
    const canJoinChannelRoom = async (cid: string): Promise<boolean> => {
      if (identity.mode === "open") return true;
      try {
        return Boolean(await channelGate.get(cid));
      } catch {
        return false;
      }
    };
    const canJoinWorkspaceRoom = async (wid: string): Promise<boolean> => {
      if (identity.mode === "open") return true;
      try {
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

    // Explicit channel join handler for room-scoped broadcast
    socket.on("channel:join" as any, async (data: any) => {
      const cid = typeof data === "string" ? data : data?.channelId;
      if (!cid || typeof cid !== "string") return;

      if (!(await canJoinChannelRoom(cid))) {
        deny("channel_not_found", `Unknown or inaccessible channel ${cid}`);
        return;
      }
      socket.join(`channel:${cid}`);

      // Catch-up replay (HM3): deliver recent durable events the client may have
      // missed while disconnected. Scoped to this socket only; ephemeral streams
      // were never persisted so they are naturally excluded.
      if (DURABLE_EVENTS_ENABLED) {
        try {
          const recent = await getDb().query.durableEvents.findMany({
            where: and(eq(durableEvents.channelId, cid)),
            orderBy: [desc(durableEvents.seq)],
            limit: 50,
          });
          for (const row of recent.reverse()) {
            // EVT-0: replayed rows carry their persisted seq + correlation fields
            const envelope: EventEnvelope = {
              eventId: row.eventId,
              seq: row.seq,
              timestamp: row.createdAt,
              type: row.type as BrokerEventType,
              payload: row.payload as never,
            };
            socket.emit(row.type as any, envelope as any);
          }
        } catch (err: any) {
          console.error("[Socket] Failed to replay durable events on channel:join:", err?.message || err);
        }
      }
    });
    socket.on("workspace:join" as any, async (data: any) => {
      const wid = typeof data === "string" ? data : data?.workspaceId;
      if (!wid || typeof wid !== "string") return;

      if (!(await canJoinWorkspaceRoom(wid))) {
        deny("workspace_not_found", `Unknown or inaccessible workspace ${wid}`);
        return;
      }
      socket.join(`workspace:${wid}`);
      socket.data.workspaceId = wid;
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

      const db = getDb();
      const { channelId, content } = payload as any;
      const rawMode = (payload as any).mode ?? (payload as any).runtimeMode;
      const explicitRuntime = composerModeToRuntime(rawMode);
      if (explicitRuntime) {
        console.log(`[Router] Override->${explicitRuntime} (from mode="${rawMode}") in #${channelId}`);
      } else {
        console.log(`[Router] Auto mode selected for message in #${channelId}`);
      }

      // Auto-join the target channel so sender receives scoped events — only
      // after the same server-side admission check as channel:join (SEC-2).
      if (channelId && typeof channelId === "string" && (await canJoinChannelRoom(channelId))) {
        socket.join(`channel:${channelId}`);
      }

      try {
        // 1. Resolve and parse mentions from content
        const resolvedMentions = await mentionParser.parseMentions(content);

        // 2. Persist the human operator's message — author identity is the
        // server-verified key identity; client authorId/authorName claims are
        // advisory only and never persisted (SEC-2). DB-2: reservation +
        // insert commit atomically (no SELECT-MAX+1 race, no PK collisions).
        const authorId = identity.userId;
        const authorName = identity.mode === "apikey"
          ? (identity.label || identity.keyId || authorId)
          : ((payload as any).authorName || (authorId === "user-1" ? "Juan Hamzah" : authorId));

        const userMsg: ChannelMessage = await withTransaction(async (tx) => {
          const sequenceNumber = await allocateSequence(channelId, 1, tx);
          const msg: ChannelMessage = {
            id: monotonicUlid(),
            channelId,
            authorId,
            authorName,
            authorLevel: "stakeholder",
            authorType: "user",
            content,
            mentions: resolvedMentions,
            isInternalMonologue: false,
            sequenceNumber,
            timestamp: new Date(),
          };
          await tx.insert(messages).values({
            ...msg,
            authorLevel: String(msg.authorLevel),
          });
          return msg;
        });

        broker.emit("message:new", userMsg, { channelId });

        // 3. Process mentions and triggers
        const allAgents = await agentRegistry.list({ isTemplate: false });

        console.log(`[Socket] user:message received in channel ${channelId}: "${content}" (resolved mentions: ${resolvedMentions.length})`);

        // PERF-1: one shared per-agent dispatch body. Status gating, busy
        // rejection (via runOrReportBusy), cancellation/failed handling and
        // error isolation are identical for explicit mentions, role mentions
        // and auto-triggered agents. Sequence numbers are allocated at persist
        // time inside triggerSystemWarning / the runtime layer (DB-2), so
        // message ordering never depends on completion order.
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
              workspaceId: 'default',
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
            const channel = await db.query.channels.findFirst({
              where: eq(channels.id, channelId),
            });
            let targetAgents: typeof allAgents = [];
            if (channel?.categoryId) {
              const category = await db.query.categories.findFirst({
                where: eq(categories.id, channel.categoryId),
              });
              if (category?.ownedByAgentId) {
                const ownerAgent = allAgents.find(a => a.id === category.ownedByAgentId);
                if (ownerAgent && ownerAgent.status !== "offline" && ownerAgent.status !== "paused") {
                  targetAgents.push(ownerAgent);
                }
              }
            }
            if (targetAgents.length === 0) {
              const l0Agents = allAgents.filter(a => a.authorityLevel === 0 && a.status !== "offline" && a.status !== "paused");
              if (l0Agents.length > 0) targetAgents = l0Agents;
            }
            if (targetAgents.length === 0) {
              const defaultAgent = allAgents.find(a => a.name === "default-assistant" && a.status !== "offline" && a.status !== "paused")
                || allAgents.find(a => a.status === "idle" || a.status === "working");
              if (defaultAgent) targetAgents = [defaultAgent];
            }
            for (const agent of targetAgents) agentsToEnqueue.push(agent);
          }

          // Optimized: pre-filter paused/offline, then parallel enqueue (was serial await per agent)
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
                const provisionalRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${agent.id.slice(0, 6)}`;
                await queueGate.enqueueRun({
                  runId: provisionalRunId,
                  channelId,
                  agentId: agent.id,
                  messageId: userMsg.id,
                  userInput: content,
                  workspaceId: "default",
                });
                broker.emit("run.queued" as never, { runId: provisionalRunId, channelId, agentId: agent.id } as never, { channelId });
                console.log(`[Socket][Queue] Enqueued run ${provisionalRunId} for @${agent.name} in #${channelId} (msg ${userMsg.id})`);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[Socket][Queue] Failed to enqueue agent @${agent.name}:`, msg);
                await triggerSystemWarning(broker, channelId, `System error queueing @${agent.name}: ${msg}`);
              }
            });
          }
          await runBoundedBatch(enqueueTasks, Math.min(4, enqueueTasks.length) || 1);
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
            const channel = await db.query.channels.findFirst({
              where: eq(channels.id, channelId),
            });

            let targetAgents: typeof allAgents = [];

            if (channel?.categoryId) {
              const category = await db.query.categories.findFirst({
                where: eq(categories.id, channel.categoryId),
              });
              if (category?.ownedByAgentId) {
                const ownerAgent = allAgents.find(a => a.id === category.ownedByAgentId);
                if (ownerAgent && ownerAgent.status !== "offline" && ownerAgent.status !== "paused") {
                  targetAgents.push(ownerAgent);
                }
              }
            }

            if (targetAgents.length === 0) {
              const l0Agents = allAgents.filter(a => a.authorityLevel === 0 && a.status !== "offline" && a.status !== "paused");
              if (l0Agents.length > 0) {
                targetAgents = l0Agents;
              }
            }

            if (targetAgents.length === 0) {
              const defaultAgent = allAgents.find(a => a.name === "default-assistant" && a.status !== "offline" && a.status !== "paused")
                || allAgents.find(a => a.status === "idle" || a.status === "working");
              if (defaultAgent) {
                targetAgents = [defaultAgent];
              }
            }

            for (const agent of targetAgents) {
              batch.push(() =>
                dispatchAgent(
                  agent,
                  `[Socket] Auto-triggering agent @${agent.name} for unmentioned message in #${channel?.name || channelId}...`,
                ),
              );
            }
          }

          if (batch.length > 0) {
            const parallelLimit = resolveMaxParallelAgents();
            const batchStartedAt = Date.now();
            await runBoundedBatch(batch, parallelLimit);
            logMetric({
              stage: "mention.dispatch",
              durationMs: Date.now() - batchStartedAt,
              agents: batch.length,
              parallel: parallelLimit,
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
        const { runsGate } = await import("../../Runs/runsGate.js");
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
          const { runtimeGate } = await import("../../runtime/runtimeGate.js");
          const { agentGate } = await import("../../Agents/agentGate.js");
          const { EventBroker } = await import("../../EventBroker/eventBrokerGate.js");
          const broker = new EventBroker();
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
        const { runsGate } = await import("../../Runs/runsGate.js");
        const entries = await runsGate.listCompensations(runId);
        const { EventBroker } = await import("../../EventBroker/eventBrokerGate.js");
        const broker = new EventBroker();
        broker.emit("run.compensations" as never, { runId, entries: entries.map(e => ({ id: e.id, seq: e.seq, toolName: e.toolName, targetPath: e.targetPath, inverseOp: e.inverseOp as unknown as { op: string; path: string }, createdAt: e.createdAt.toISOString() })) } as never, { channelId: (await runsGate.getById(runId))?.channelId } as never);
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
        const { runsGate } = await import("../../Runs/runsGate.js");
        const result = await runsGate.undoCompensation(runId, compId);
        if (!result.ok) {
          socket.emit("error" as any, { code: "undo_failed", message: result.error });
          return;
        }
        const entries = await runsGate.listCompensations(runId);
        socket.emit("run:compensations" as any, { runId, entries });
        const { EventBroker } = await import("../../EventBroker/eventBrokerGate.js");
        const broker = new EventBroker();
        const run = await runsGate.getById(runId);
        broker.emit("run.compensations" as never, { runId, entries: entries.map(e => ({ id: e.id, seq: e.seq, toolName: e.toolName, targetPath: e.targetPath, inverseOp: e.inverseOp as unknown as { op: string; path: string }, createdAt: e.createdAt.toISOString() })) } as never, { channelId: run?.channelId } as never);
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
        const { approvalGate } = await import("../../Approvals/approvalGate.js");
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
          const { runsGate } = await import("../../Runs/runsGate.js");
          const run = await runsGate.getById(updated.runId);
          channelIdForRun = run?.channelId;
          broker.emit("approval.decided" as never, {
            runId: updated.runId,
            approvalId: updated.id,
            tool: updated.toolName,
            decision: decision as "approved" | "denied",
            decidedBy,
            scope: updated.scope,
            riskClass: updated.riskClass,
            channelId: channelIdForRun,
          } as never, channelIdForRun ? { channelId: channelIdForRun } as never : undefined as never);
        } catch {}
        // APR-1: ensure run resumes even if no live poller (orphaned). Poller also transitions, so idempotent.
        try {
          const { runsGate } = await import("../../Runs/runsGate.js");
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
        const { approvalGate } = await import("../../Approvals/approvalGate.js");
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
