import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { createRedisConnection, getQueueMode } from "./connection.js";
import { MAINTENANCE_QUEUE_NAME } from "./queues.js";

let maintenanceWorker: Worker | null = null;
let maintenanceConn: InstanceType<typeof IORedis> | null = null;

async function handleLibrarianDelta(): Promise<void> {
  try {
    const [{ EventBroker, getSharedBroker }] = await Promise.all([import("../event-broker/event-broker-gate.js")]);
    // Worker-local by design (no socket server in this process); shared when set at boot.
    const broker = (getSharedBroker as () => InstanceType<typeof EventBroker> | null)?.() ?? new EventBroker();
    const mod = await import("../shared/core/index-builder.js");
    const builder = (mod as unknown as { IndexBuilder: { reindexStaleChannels: (b: unknown) => Promise<void> } }).IndexBuilder;
    await builder.reindexStaleChannels(broker);
  } catch (err) {
    console.error("[maintenance:librarian-delta] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleHeartbeatTouch(): Promise<void> {
  try {
    const mod = await import("../shared/core/agent-heartbeat.js");
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
    throw err;
  }
}

async function handleOrphanSweep(): Promise<void> {
  try {
    const [{ EventBroker, getSharedBroker }] = await Promise.all([import("../event-broker/event-broker-gate.js")]);
    // Worker-local by design (no socket server in this process); shared when set at boot.
    const broker = (getSharedBroker as () => InstanceType<typeof EventBroker> | null)?.() ?? new EventBroker();
    const mod = await import("../shared/core/agent-heartbeat.js");
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
    const [{ EventBroker, getSharedBroker }] = await Promise.all([import("../event-broker/event-broker-gate.js")]);
    // Worker-local by design (no socket server in this process); shared when set at boot.
    const broker = (getSharedBroker as () => InstanceType<typeof EventBroker> | null)?.() ?? new EventBroker();
    const { runsGate } = await import("../runs/runs-gate.js");
    const fn = (runsGate as unknown as { sweepOrphanedRuns: (b: unknown) => Promise<number> }).sweepOrphanedRuns;
    if (typeof fn === "function") await fn(broker);
  } catch (err) {
    console.error("[maintenance:orphan-resume] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleSuppressExpiry(): Promise<void> {
  try {
    const mod = await import("../memories/memories-gate.js");
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
    const spawnMod = await import("../agents/agent-gate.js");
    const fn =
      ((spawnMod as Record<string, unknown>).runSpawnRetentionSweep as
        | (() => Promise<void>)
        | undefined) ||
      ((spawnMod as Record<string, unknown>).agentGate as unknown as { runRetention?: () => Promise<void> })?.runRetention;
    if (typeof fn === "function") await fn();
  } catch (err) {
    console.error("[maintenance:retention] failed", (err as Error)?.message || err);
    throw err;
  }
  try {
    const tok = await import("../shared/core/token-tracker.js");
    const fn = (tok as Record<string, unknown>).reconcileBudgetUsage as
      | (() => Promise<void>)
      | undefined;
    if (typeof fn === "function") await fn();
  } catch (err) {
    console.error("[maintenance:retention] partial failure", (err as Error)?.message || err);
    throw err;
  }
}

async function handleApprovalExpire(): Promise<void> {
  try {
    const { sweepApprovalsOnce } = await import("../approvals/approval-sweeper.js");
    const { EventBroker, getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    // Worker-local by design (no socket server in this process); shared when set at boot.
    const broker = (getSharedBroker as () => InstanceType<typeof EventBroker> | null)?.() ?? new EventBroker();
    await sweepApprovalsOnce(broker);
  } catch (err) {
    console.error("[maintenance:approval-expire] failed", (err as Error)?.message || err);
    throw err;
  }
}

async function handleSnapshotFull(): Promise<void> {
  try {
    const [{ EventBroker, getSharedBroker }] = await Promise.all([import("../event-broker/event-broker-gate.js")]);
    // Worker-local by design: runtime:snapshot here reaches no socket;
    // shared when set at boot (same-process API), fresh otherwise.
    const broker = (getSharedBroker as () => InstanceType<typeof EventBroker> | null)?.() ?? new EventBroker();
    const dbMod = await import("../shared/config/database.js");
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
      const snapshot = {
        workspaces: (dbWorkspaces as Array<Record<string, unknown>>).map((ws) => ({
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
        agents: (dbAgents as Array<Record<string, unknown>>)
          .filter((ag) => !(ag as { archivedAt?: unknown }).archivedAt)
          .map((ag) => ({
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
          })),
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
        sandboxes: (dbWorkspaces as Array<Record<string, unknown>>).map((ws) => ({
          sandboxId: `sb-${ws.id}`,
          workspaceId: ws.id,
          status: "idle" as const,
          activeProcesses: [],
          memoryUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          cpuUsagePercent: 0,
          lastUpdated: new Date().toISOString(),
        })),
        overrides: (dbOverrides as Array<Record<string, unknown>>).map((ov) => ({
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
      broker.emit("runtime:snapshot" as never, snapshot as never);
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
  maintenanceConn = conn;
  maintenanceWorker = new Worker(MAINTENANCE_QUEUE_NAME, maintenanceProcessor, {
    connection: conn as unknown as IORedis,
    concurrency: 2,
    // M2: stall tuning explicit (BullMQ v6 defaults). lockDuration 15min kept:
    // sweeps are short but run on shared Redis; shorter lock adds false-stall
    // churn for no gain. Crashes surface via 'stalled' below.
    lockDuration: 900000,
    stalledInterval: 30000,
    maxStalledCount: 1,
  });
  // M2: Worker is the stall checker — observe its queue events with jobId.
  maintenanceWorker.on("error", (err) => console.error("[maintenance:worker:error]", (err as Error)?.message ?? err));
  maintenanceWorker.on("completed", (job) => console.log(`[maintenance:completed] jobId=${job.id}`));
  maintenanceWorker.on("failed", (job, err) => console.warn(`[maintenance:failed] jobId=${job?.id} ${(err as Error)?.message ?? err}`));
  maintenanceWorker.on("stalled", (jobId) => console.warn(`[maintenance:stalled] jobId=${jobId}`));
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
  if (maintenanceConn) {
    const c = maintenanceConn;
    maintenanceConn = null;
    try {
      await c.quit();
    } catch {
      try {
        c.disconnect();
      } catch {}
    }
  }
}

export function resetMaintenanceWorkerForTests(): void {
  maintenanceWorker = null;
  maintenanceConn = null;
}
