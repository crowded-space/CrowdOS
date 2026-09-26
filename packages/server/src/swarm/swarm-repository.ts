import { eq } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { swarmTasks } from "../db/schema.js";
import type { SwarmPlanTask, SwarmTaskRow, SwarmTaskStatus } from "./swarm-types.js";
import { resetDelegationRepositoryForTests } from "./delegation-repository.js";

type DbSwarmTask = typeof swarmTasks.$inferSelect;

// swarm_tasks.id is a global PK, but plan task ids ("task-1") are unique only
// within a plan: a second run inserting the same id collides and the whole
// insert fails. Rows are stored under `${runId}::${taskId}` and mapped back to
// the bare id on every read/write, so callers keep passing plan ids.
const ID_SEP = "::";
// ponytail: fixed row cap, not an LRU — the maps are a coherence layer over PG,
// not a cache. Raise or switch to LRU if a single run ever exceeds 500 tasks.
const MEM_ROW_CAP = 500;

function toDbId(runId: string, taskId: string): string {
  return `${runId}${ID_SEP}${taskId}`;
}

function toBareId(runId: string, dbId: string): string {
  const prefix = `${runId}${ID_SEP}`;
  return dbId.startsWith(prefix) ? dbId.slice(prefix.length) : dbId;
}

function toRow(r: DbSwarmTask): SwarmTaskRow {
  return {
    id: toBareId(r.runId, r.id),
    runId: r.runId,
    dependsOn: (r.dependsOn as string[]) ?? [],
    assigneeTemplate: r.assigneeTemplate,
    status: r.status as SwarmTaskStatus,
    outputRef: r.outputRef ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const ALLOWED_TRANSITIONS: Record<SwarmTaskStatus, SwarmTaskStatus[]> = {
  pending: ["running", "failed", "blocked"],
  running: ["completed", "failed", "blocked"],
  completed: [],
  failed: [],
  blocked: [],
};

function canTransition(from: SwarmTaskStatus, to: SwarmTaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// In-memory store: coherent read-after-write layer for hermetic tests, and a
// fallback when PG is unavailable. memOnly rows are ones PG never received, so
// a later PG read must never overwrite them (they would otherwise revert).
const memByRun = new Map<string, Map<string, SwarmTaskRow>>();
const memById = new Map<string, SwarmTaskRow>();
const memOnly = new Set<string>();

function isHermeticMode(): boolean {
  // Hermetic when testing or no DB configured or explicit fake DB flag
  if (process.env.__SOCKET_FAKE_DB__ === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return true;
  return false;
}

function memPut(row: SwarmTaskRow): SwarmTaskRow {
  memById.set(toDbId(row.runId, row.id), row);
  let byRun = memByRun.get(row.runId);
  if (!byRun) {
    byRun = new Map();
    memByRun.set(row.runId, byRun);
  }
  byRun.set(row.id, row);
  return row;
}

function memDrop(dbId: string): void {
  const row = memById.get(dbId);
  memById.delete(dbId);
  memOnly.delete(dbId);
  if (row) {
    const byRun = memByRun.get(row.runId);
    if (byRun) {
      byRun.delete(row.id);
      if (byRun.size === 0) memByRun.delete(row.runId);
    }
  }
}

function memClearRun(runId: string): void {
  const byRun = memByRun.get(runId);
  if (byRun) for (const id of [...byRun.keys()]) memDrop(toDbId(runId, id));
  memByRun.delete(runId);
}

function memEvict(): void {
  while (memById.size > MEM_ROW_CAP) {
    // Prefer dropping PG-backed rows: memOnly rows exist nowhere else.
    let victim: string | undefined;
    for (const key of memById.keys()) {
      if (!memOnly.has(key)) {
        victim = key;
        break;
      }
    }
    if (victim === undefined) victim = memById.keys().next().value;
    if (victim === undefined) return;
    memDrop(victim);
  }
}

function memListByRun(runId: string): SwarmTaskRow[] {
  const m = memByRun.get(runId);
  if (!m) return [];
  return [...m.values()];
}

function memGetById(runId: string, taskId: string): SwarmTaskRow | null {
  return memById.get(toDbId(runId, taskId)) ?? null;
}

function applyMem(existing: SwarmTaskRow, status: SwarmTaskStatus, outputRef?: string | null): SwarmTaskRow {
  existing.status = status;
  if (outputRef !== undefined) existing.outputRef = outputRef;
  existing.updatedAt = new Date();
  return { ...existing };
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
  const storeRows = (memOnlyRows: boolean): void => {
    for (const r of rows) {
      const dbId = toDbId(runId, r.id);
      memPut({ ...r });
      if (memOnlyRows) memOnly.add(dbId);
      else memOnly.delete(dbId);
    }
    memEvict();
  };

  if (isHermeticMode()) {
    storeRows(false);
    return rows.map((r) => ({ ...r }));
  }

  try {
    const db = getDb();
    const values = rows.map((r) => ({
      id: toDbId(runId, r.id),
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
    storeRows(false);
    return rows.map((r) => ({ ...r }));
  } catch (err) {
    // Fallback to mem on DB failure (migration missing, network etc.) — log and continue honestly
    console.warn("[swarmRepository] createSwarmTasks DB write failed, falling back to memory:", (err as Error)?.message || err);
    storeRows(true);
    return rows.map((r) => ({ ...r }));
  }
}

export async function updateSwarmTaskStatus(
  runId: string,
  taskId: string,
  status: SwarmTaskStatus,
  outputRef?: string | null
): Promise<SwarmTaskRow | null> {
  const dbId = toDbId(runId, taskId);
  const existing = memById.get(dbId);
  if (existing && !canTransition(existing.status, status)) {
    console.warn(`[swarmRepository] rejected illegal transition ${existing.status} -> ${status} for ${taskId} (run ${runId})`);
    return null;
  }

  if (isHermeticMode()) {
    if (!existing) return null;
    return applyMem(existing, status, outputRef);
  }

  try {
    const db = getDb();
    const patch: Record<string, unknown> = { status: status as any, updatedAt: new Date() };
    if (outputRef !== undefined) patch.outputRef = outputRef;
    const [row] = await db
      .update(swarmTasks)
      .set(patch as any)
      .where(eq(swarmTasks.id, dbId))
      .returning();
    if (row) {
      const converted = toRow(row as DbSwarmTask);
      memOnly.delete(dbId);
      memPut({ ...converted });
      return converted;
    }
    // No PG row: the row is mem-only (earlier failed insert) or was deleted.
    if (existing) {
      memOnly.add(dbId);
      return applyMem(existing, status, outputRef);
    }
    return null;
  } catch (err) {
    console.warn("[swarmRepository] updateSwarmTaskStatus DB failed, falling back to mem:", (err as Error)?.message || err);
    if (!existing) return null;
    memOnly.add(dbId);
    return applyMem(existing, status, outputRef);
  }
}

export async function listSwarmTasksByRun(runId: string): Promise<SwarmTaskRow[]> {
  if (isHermeticMode()) {
    return memListByRun(runId).map((r) => ({ ...r }));
  }
  try {
    const db = getDb();
    const rows = await db.select().from(swarmTasks).where(eq(swarmTasks.runId, runId)).limit(MEM_ROW_CAP);
    const merged = new Map<string, SwarmTaskRow>();
    for (const raw of rows as DbSwarmTask[]) {
      if (memOnly.has(raw.id)) continue; // mem is authoritative for this row
      const converted = toRow(raw);
      merged.set(converted.id, converted);
    }
    const byRun = memByRun.get(runId);
    if (byRun) {
      for (const [id, row] of byRun) {
        if (memOnly.has(toDbId(runId, id))) merged.set(id, { ...row });
      }
      if (merged.size === 0) {
        // PG has no rows (writes went to mem) — keep read-after-write coherence
        for (const [id, row] of byRun) merged.set(id, { ...row });
      }
    }
    for (const converted of merged.values()) {
      if (!memOnly.has(toDbId(runId, converted.id))) memPut({ ...converted });
    }
    memEvict();
    return [...merged.values()];
  } catch (err) {
    console.warn("[swarmRepository] listSwarmTasksByRun DB failed, using mem:", (err as Error)?.message || err);
    return memListByRun(runId).map((r) => ({ ...r }));
  }
}

export async function getSwarmTaskById(runId: string, taskId: string): Promise<SwarmTaskRow | null> {
  const dbId = toDbId(runId, taskId);
  if (isHermeticMode()) {
    const r = memGetById(runId, taskId);
    return r ? { ...r } : null;
  }
  try {
    const db = getDb();
    const [row] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, dbId)).limit(1);
    if (!row || memOnly.has(dbId)) {
      const mem = memGetById(runId, taskId);
      return mem ? { ...mem } : null;
    }
    const converted = toRow(row as DbSwarmTask);
    memPut({ ...converted });
    return converted;
  } catch {
    const mem = memGetById(runId, taskId);
    return mem ? { ...mem } : null;
  }
}

export async function deleteSwarmTasksByRun(runId: string): Promise<void> {
  if (isHermeticMode()) {
    memClearRun(runId);
    return;
  }
  try {
    const db = getDb();
    // drizzle delete with where runId
    await db.delete(swarmTasks).where(eq(swarmTasks.runId, runId));
  } catch (err) {
    console.warn("[swarmRepository] deleteSwarmTasksByRun DB failed:", (err as Error)?.message || err);
  }
  memClearRun(runId);
}

export function resetSwarmRepositoryForTests(): void {
  memByRun.clear();
  memById.clear();
  memOnly.clear();
  // NOTE: mem-only reset. DB rows in swarmTasks persist outside hermetic mode;
  // tests run hermetic (NODE_ENV=test), so this is sufficient there.
}

export function resetSwarmForTests(): void {
  resetSwarmRepositoryForTests();
  resetDelegationRepositoryForTests();
}
