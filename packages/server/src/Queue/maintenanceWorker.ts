import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { createRedisConnection, getQueueMode } from "./connection.js";
import { MAINTENANCE_QUEUE_NAME } from "./queues.js";

let maintenanceWorker: Worker | null = null;

async function handleLibrarianDelta(): Promise<void> {
  try {
    const [{ EventBroker }] = await Promise.all([import("../EventBroker/eventBrokerGate.js")]);
    const broker = new EventBroker();
    const mod = await import("../Shared/core/indexBuilder.js");
    const builder = (mod as unknown as { IndexBuilder: { reindexStaleChannels: (b: unknown) => Promise<void> } }).IndexBuilder;
    await builder.reindexStaleChannels(broker);
  } catch (err) {
    console.error("[maintenance:librarian-delta] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleHeartbeatTouch(): Promise<void> {
  try {
    const mod = await import("../Shared/core/agentHeartbeat.js");
    const fn = (mod as Record<string, unknown>).touchWorkingAgents as
      | (() => Promise<void>)
      | undefined;
    if (typeof fn === "function") {
      await fn();
      return;
    }
    // Fallback: at least ensure module loaded and no-op heartbeat
  } catch (err) {
    console.error("[maintenance:heartbeats-touch] failed", (err as Error)?.message || err);
  }
}

async function handleOrphanSweep(): Promise<void> {
  try {
    const [{ EventBroker }] = await Promise.all([import("../EventBroker/eventBrokerGate.js")]);
    const broker = new EventBroker();
    const mod = await import("../Shared/core/agentHeartbeat.js");
    const fn = (mod as Record<string, unknown>).sweepOrphans as
      | ((b: unknown) => Promise<void>)
      | undefined;
    if (typeof fn === "function") await fn(broker);
  } catch (err) {
    console.error("[maintenance:orphan-sweep] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleOrphanResume(): Promise<void> {
  try {
    const [{ EventBroker }] = await Promise.all([import("../EventBroker/eventBrokerGate.js")]);
    const broker = new EventBroker();
    const { runsGate } = await import("../Runs/runsGate.js");
    const fn = (runsGate as unknown as { sweepOrphanedRuns: (b: unknown) => Promise<number> }).sweepOrphanedRuns;
    if (typeof fn === "function") await fn(broker);
  } catch (err) {
    console.error("[maintenance:orphan-resume] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleSuppressExpiry(): Promise<void> {
  try {
    const mod = await import("../Memories/memoriesGate.js");
    const gate = (mod as Record<string, unknown>).memoriesGate as
      | { runMemorySweep?: () => Promise<unknown> }
      | undefined;
    if (gate && typeof gate.runMemorySweep === "function") {
      await gate.runMemorySweep();
      return;
    }
    const direct = (mod as Record<string, unknown>).runSuppressionSweep as
      | (() => Promise<void>)
      | undefined;
    if (typeof direct === "function") await direct();
  } catch (err) {
    console.error("[maintenance:suppress-expiry] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleRetention(): Promise<void> {
  try {
    const spawnMod = await import("../Agents/agentGate.js");
    const fn =
      ((spawnMod as Record<string, unknown>).runSpawnRetentionSweep as
        | (() => Promise<void>)
        | undefined) ||
      ((spawnMod as Record<string, unknown>).agentGate as unknown as { runRetention?: () => Promise<void> })?.runRetention;
    if (typeof fn === "function") await fn();
  } catch {}
  try {
    const tok = await import("../Shared/core/tokenTracker.js");
    const fn = (tok as Record<string, unknown>).reconcileBudgetUsage as
      | (() => Promise<void>)
      | undefined;
    if (typeof fn === "function") await fn();
  } catch (err) {
    console.error("[maintenance:retention] partial failure", (err as Error)?.message || err);
  }
}

async function handleApprovalExpire(): Promise<void> {
  try {
    const { sweepApprovalsOnce } = await import("../Approvals/approvalSweeper.js");
    const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
    const broker = new EventBroker();
    await sweepApprovalsOnce(broker);
  } catch (err) {
    console.error("[maintenance:approval-expire] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleSnapshotFull(): Promise<void> {
  try {
    const [{ EventBroker }] = await Promise.all([import("../EventBroker/eventBrokerGate.js")]);
    // Prefer the live socket broker so snapshots reach workspace rooms; a
    // fresh broker preserves legacy in-process behavior when absent.
    let broker: InstanceType<typeof EventBroker>;
    try {
      const socketMod = (await import("../Shared/sockets/registerSocketServer.js")) as unknown as { globalBroker?: InstanceType<typeof EventBroker> | null };
      broker = (socketMod.globalBroker as InstanceType<typeof EventBroker>) ?? new EventBroker();
    } catch {
      broker = new EventBroker();
    }
    const dbMod = await import("../Shared/config/database.js");
    const getDb = (dbMod as Record<string, unknown>).getDb as () => unknown;
    let db: unknown = null;
    try {
      db = getDb();
    } catch {}
    if (!db) return;
    const schemaMod = await import("../db/schema.js");
    const { agents, workspaces, runtimeOverrides, spawnRequests } = schemaMod as Record<string, unknown>;
    try {
      const anyDb = db as {
        query: Record<string, { findMany: (opts?: unknown) => Promise<unknown[]> }>;
      };
      const [dbWorkspaces, dbAgents, dbOverrides, activeSpawns] = await Promise.all([
        anyDb.query.workspaces.findMany().catch(() => []),
        anyDb.query.agents.findMany({}).catch(() => []),
        anyDb.query.runtimeOverrides.findMany().catch(() => []),
        anyDb.query.spawnRequests.findMany({}).catch(() => []),
      ]);
      // Mounts define each workspace roster — resolve once, fan out per workspace.
      let mounts: Array<Record<string, unknown>> = [];
      try {
        const rows = await anyDb.query.workspaceAgents.findMany().catch(() => []);
        mounts = (rows as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
      } catch {}
      const mountedByWorkspace = new Map<string, Set<string>>();
      for (const mount of mounts) {
        const wid = mount.workspaceId as string;
        if (!mountedByWorkspace.has(wid)) mountedByWorkspace.set(wid, new Set());
        mountedByWorkspace.get(wid)?.add(mount.agentId as string);
      }
      const liveAgents = (dbAgents as Array<Record<string, unknown>>)
        .filter((ag) => !(ag as { archivedAt?: unknown }).archivedAt);
      const mapAgent = (ag: Record<string, unknown>) => ({
        id: ag.id,
        name: ag.name,
        title: ag.title,
        species: (ag as { species?: string }).species || "AI Assistant",
        avatar: (ag as { avatar?: string }).avatar || "🤖",
        authorityLevel: ag.authorityLevel,
        status: (ag as { status?: string }).status || "idle",
        instructionModuleId: ag.instructionModuleId,
        modelModuleId: ag.modelModuleId,
        toolkitModuleId: ag.toolkitModuleId,
        isOmniscient: (ag as { isOmniscient?: boolean }).isOmniscient || false,
        createdAt: (ag.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: (ag.updatedAt as Date)?.toISOString?.() ?? new Date().toISOString(),
      });
      const mapWorkspace = (ws: Record<string, unknown>) => ({
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
      });
      // Per-workspace snapshots: each tenant room receives only its own roster.
      for (const ws of dbWorkspaces as Array<Record<string, unknown>>) {
        const wid = ws.id as string;
        const mounted = mountedByWorkspace.get(wid) ?? new Set<string>();
        const agents = liveAgents
          .filter((ag) => mounted.has(ag.id as string))
          .map(mapAgent);
        const snapshot = {
          workspaces: [mapWorkspace(ws)],
          agents,
          swarms: (activeSpawns as Array<Record<string, unknown>>)
            .filter((s) => (s as { status?: string }).status === "in_progress")
            .map((spawn) => ({
              swarmId: spawn.id,
              name: `Swarm ${(spawn.id as string).slice(0, 8)}`,
              status: "active" as const,
              members: [
                spawn.requestedBy,
                (spawn as { workerTemplateId?: string }).workerTemplateId,
                (spawn as { supervisorTemplateId?: string }).supervisorTemplateId,
              ].filter(Boolean),
              activeTasksCount: Array.isArray(spawn.subtasks) ? (spawn.subtasks as unknown[]).length : 0,
              createdAt: (spawn.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
            })),
          escalations: [],
          sandboxes: [{
            sandboxId: `sb-${wid}`,
            workspaceId: wid,
            status: "idle" as const,
            activeProcesses: [],
            memoryUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            cpuUsagePercent: 0,
            lastUpdated: new Date().toISOString(),
          }],
          overrides: (dbOverrides as Array<Record<string, unknown>>)
            .filter((ov) => mounted.has((ov as { targetAgentId?: string }).targetAgentId as string))
            .map((ov) => ({
              id: ov.id,
              agentId: (ov as { targetAgentId?: string }).targetAgentId,
              type: (ov as { overrideType?: string }).overrideType === "runtime_patch" ? "instruction" : "model",
              patch: ((ov as { instructionPatch?: unknown }).instructionPatch ||
                (ov as { permissionPatch?: unknown }).permissionPatch ||
                {}) as Record<string, unknown>,
              reason: ov.createdBy,
              active: true,
              createdAt: (ov.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
            })),
          runtimeHealth: { status: "healthy" as const, timestamp: new Date().toISOString() },
        };
        broker.emit("runtime:snapshot" as never, snapshot as never, { workspaceId: wid } as never);
      }
    } catch (err) {
      console.error("[maintenance:snapshot-full] snapshot build failed", (err as Error)?.message || err);
    }
  } catch {}
}

async function maintenanceProcessor(job: Job): Promise<unknown> {
  switch (job.name) {
    case "librarian-delta":
      return handleLibrarianDelta();
    case "heartbeats-touch":
      return handleHeartbeatTouch();
    case "orphan-sweep":
      return handleOrphanSweep();
    case "orphan-resume":
      return handleOrphanResume();
    case "suppress-expiry":
      return handleSuppressExpiry();
    case "retention":
      return handleRetention();
    case "snapshot-full":
      return handleSnapshotFull();
    case "approval-expire":
      return handleApprovalExpire();
    default:
      switch ((job.data as { kind?: string })?.kind) {
        case "librarian-delta":
          return handleLibrarianDelta();
        case "heartbeats-touch":
          return handleHeartbeatTouch();
        case "orphan-sweep":
          return handleOrphanSweep();
        case "orphan-resume":
          return handleOrphanResume();
        case "suppress-expiry":
          return handleSuppressExpiry();
        case "retention":
          return handleRetention();
        case "snapshot-full":
          return handleSnapshotFull();
        case "approval-expire":
          return handleApprovalExpire();
        default:
          return null;
      }
  }
}

export function getMaintenanceWorker(): Worker | null {
  return maintenanceWorker;
}

export async function startMaintenanceWorker(): Promise<Worker | null> {
  if (getQueueMode() !== "bullmq") return null;
  if (maintenanceWorker) return maintenanceWorker;
  const conn = createRedisConnection() as InstanceType<typeof IORedis> | null;
  if (!conn) return null;
  maintenanceWorker = new Worker(MAINTENANCE_QUEUE_NAME, maintenanceProcessor, {
    connection: conn as unknown as IORedis,
    concurrency: 2,
    lockDuration: 900000,
  });
  maintenanceWorker.on("error", () => {});
  const bullMqFailed = "failed";
  (maintenanceWorker as unknown as { on: (e: string, h: () => void) => void }).on(bullMqFailed, () => {});
  return maintenanceWorker;
}

export async function stopMaintenanceWorker(): Promise<void> {
  if (maintenanceWorker) {
    const w = maintenanceWorker;
    maintenanceWorker = null;
    try {
      await w.close();
    } catch {}
  }
}

export function resetMaintenanceWorkerForTests(): void {
  maintenanceWorker = null;
}
