import { eq } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { swarmTasks } from "../db/schema.js";
import type { SwarmPlanTask, SwarmTaskRow, SwarmTaskStatus } from "./swarm-types.js";

type DbSwarmTask = typeof swarmTasks.$inferSelect;

function toRow(r: DbSwarmTask): SwarmTaskRow {
  return {
    id: r.id,
    runId: r.runId,
    dependsOn: (r.dependsOn as string[]) ?? [],
    assigneeTemplate: r.assigneeTemplate,
    status: r.status as SwarmTaskStatus,
    outputRef: r.outputRef ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// In-memory fallback for hermetic tests and when DB is unavailable.
// Keyed by runId -> array rows; also indexed by id for updates.
const memByRun = new Map<string, Map<string, SwarmTaskRow>>();
const memById = new Map<string, SwarmTaskRow>();

function isHermeticMode(): boolean {
  // Hermetic when testing or no DB configured or explicit fake DB flag
  if (process.env.__SOCKET_FAKE_DB__ === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return true;
  return false;
}

function memListByRun(runId: string): SwarmTaskRow[] {
  const m = memByRun.get(runId);
  if (!m) return [];
  return [...m.values()];
}

function memGetById(id: string): SwarmTaskRow | null {
  return memById.get(id) ?? null;
}

export async function createSwarmTasks(
  runId: string,
  tasks: SwarmPlanTask[]
): Promise<SwarmTaskRow[]> {
  const now = new Date();
  const rows: SwarmTaskRow[] = tasks.map((t) => ({
    id: t.id,
    runId,
    dependsOn: [...(t.dependsOn ?? [])],
    assigneeTemplate: t.assigneeTemplate,
    status: "pending",
    outputRef: null,
    createdAt: now,
    updatedAt: now,
  }));

  if (isHermeticMode()) {
    let byRun = memByRun.get(runId);
    if (!byRun) {
      byRun = new Map();
      memByRun.set(runId, byRun);
    }
    for (const r of rows) {
      byRun.set(r.id, r);
      memById.set(r.id, r);
    }
    return rows.map((r) => ({ ...r }));
  }

  try {
    const db = getDb();
    const values = rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      dependsOn: r.dependsOn,
      assigneeTemplate: r.assigneeTemplate,
      status: r.status as any,
      outputRef: r.outputRef,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    await db.insert(swarmTasks).values(values as any);
    // Also keep in mem for read-after-write coherence in same process
    let byRun = memByRun.get(runId);
    if (!byRun) {
      byRun = new Map();
      memByRun.set(runId, byRun);
    }
    for (const r of rows) {
      byRun.set(r.id, r);
      memById.set(r.id, r);
    }
    return rows;
  } catch (err) {
    // Fallback to mem on DB failure (migration missing, network etc.) — log and continue honestly
    console.warn("[swarmRepository] createSwarmTasks DB write failed, falling back to memory:", (err as Error)?.message || err);
    let byRun = memByRun.get(runId);
    if (!byRun) {
      byRun = new Map();
      memByRun.set(runId, byRun);
    }
    for (const r of rows) {
      byRun.set(r.id, r);
      memById.set(r.id, r);
    }
    return rows.map((r) => ({ ...r }));
  }
}

export async function updateSwarmTaskStatus(
  taskId: string,
  status: SwarmTaskStatus,
  outputRef?: string | null
): Promise<SwarmTaskRow | null> {
  if (isHermeticMode()) {
    const existing = memById.get(taskId);
    if (!existing) return null;
    existing.status = status;
    if (outputRef !== undefined) existing.outputRef = outputRef;
    existing.updatedAt = new Date();
    return { ...existing };
  }
  try {
    const db = getDb();
    const patch: Record<string, unknown> = { status: status as any, updatedAt: new Date() };
    if (outputRef !== undefined) patch.outputRef = outputRef;
    const [row] = await db
      .update(swarmTasks)
      .set(patch as any)
      .where(eq(swarmTasks.id, taskId))
      .returning();
    if (!row) return null;
    const converted = toRow(row as DbSwarmTask);
    // keep mem in sync
    memById.set(taskId, { ...converted });
    const byRun = memByRun.get(converted.runId);
    if (byRun) byRun.set(taskId, { ...converted });
    return converted;
  } catch (err) {
    console.warn("[swarmRepository] updateSwarmTaskStatus DB failed, falling back to mem:", (err as Error)?.message || err);
    const existing = memById.get(taskId);
    if (!existing) return null;
    existing.status = status;
    if (outputRef !== undefined) existing.outputRef = outputRef;
    existing.updatedAt = new Date();
    return { ...existing };
  }
}

export async function listSwarmTasksByRun(runId: string): Promise<SwarmTaskRow[]> {
  if (isHermeticMode()) {
    return memListByRun(runId).map((r) => ({ ...r }));
  }
  try {
    const db = getDb();
    const rows = await db.select().from(swarmTasks).where(eq(swarmTasks.runId, runId)).limit(500);
    if (rows.length === 0) {
      // Fallback to mem if DB has no rows but mem does (e.g., hermetic writes before DB ready)
      const mem = memListByRun(runId);
      if (mem.length > 0) return mem.map((r) => ({ ...r }));
    }
    const converted = (rows as DbSwarmTask[]).map(toRow);
    // sync mem
    if (converted.length > 0) {
      let byRun = memByRun.get(runId);
      if (!byRun) {
        byRun = new Map();
        memByRun.set(runId, byRun);
      }
      for (const c of converted) {
        byRun.set(c.id, { ...c });
        memById.set(c.id, { ...c });
      }
    }
    return converted;
  } catch (err) {
    console.warn("[swarmRepository] listSwarmTasksByRun DB failed, using mem:", (err as Error)?.message || err);
    return memListByRun(runId).map((r) => ({ ...r }));
  }
}

export async function getSwarmTaskById(taskId: string): Promise<SwarmTaskRow | null> {
  if (isHermeticMode()) {
    const r = memGetById(taskId);
    return r ? { ...r } : null;
  }
  try {
    const db = getDb();
    const [row] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)).limit(1);
    if (!row) {
      const mem = memGetById(taskId);
      return mem ? { ...mem } : null;
    }
    const converted = toRow(row as DbSwarmTask);
    memById.set(taskId, { ...converted });
    return converted;
  } catch {
    const mem = memGetById(taskId);
    return mem ? { ...mem } : null;
  }
}

export async function deleteSwarmTasksByRun(runId: string): Promise<void> {
  if (isHermeticMode()) {
    const byRun = memByRun.get(runId);
    if (byRun) {
      for (const id of [...byRun.keys()]) memById.delete(id);
      memByRun.delete(runId);
    }
    return;
  }
  try {
    const db = getDb();
    const { inArray } = await import("drizzle-orm");
    // drizzle delete with where runId
    await db.delete(swarmTasks).where(eq(swarmTasks.runId, runId));
  } catch (err) {
    console.warn("[swarmRepository] deleteSwarmTasksByRun DB failed:", (err as Error)?.message || err);
  }
  const byRun = memByRun.get(runId);
  if (byRun) {
    for (const id of [...byRun.keys()]) memById.delete(id);
    memByRun.delete(runId);
  }
}

export function resetSwarmRepositoryForTests(): void {
  memByRun.clear();
  memById.clear();
}
