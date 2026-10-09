import { randomUUID } from "node:crypto";
import { and, count as sqlCount, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb, runWithDb, dbScopeKey, isDatabaseConfigured, dbForWorkspace } from "../shared/config/database.js";
import { forEachWorkspaceDb } from "../workspace/workspace-gate.js";
import { agentMemoryNotes, memoryUpdateLog } from "../db/schema.js";
import { numEnv } from "./memory-env.js";
import { memorySessionDiscards } from "./memory-session-discards.js";

/**
 * Record-only workspace context (CrowdOS §17): callers that hold a workspace
 * id thread it through the trailing `opts` parameter. When present, the
 * memory handle resolves from the workspace record (`dbForWorkspace`) and a
 * NO_DATABASE/unreachable workspace degrades to the local mirror. When
 * absent, the legacy env-gated behaviour is preserved (a set env URL may
 * still back context-free callers; the supported config leaves it unset).
 */
export interface MemoryWorkspaceOpts {
  workspaceId?: string | null;
}

/**
 * Resolve the effective memory DB handle. Returns null when the operation
 * must degrade to the local mirror (no workspace DB, no configured env DB,
 * or a handle-resolution failure).
 *
 * Precedence: explicit workspace id → ALS-bound tenant handle (the sweep
 * fan-out binds one per workspace via runWithDb) → env-gated legacy handle.
 * @internal shared across the memories domain modules.
 */
export async function resolveMemoryDb(opts?: MemoryWorkspaceOpts): Promise<ReturnType<typeof getDb> | null> {
  if (opts?.workspaceId) {
    try {
      return await dbForWorkspace(opts.workspaceId);
    } catch {
      return null;
    }
  }
  // ALS-bound handle (workspace sweep scope) always wins over the env gate.
  if (dbScopeKey() !== "global") {
    try {
      return getDb();
    } catch {
      return null;
    }
  }
  if (!isDatabaseConfigured()) return null;
  try {
    return getDb();
  } catch {
    return null;
  }
}

export type MemoryUpdateAction =
  | "create"
  | "update"
  | "archive"
  | "suppress"
  | "suppress_soft"
  | "suppress_expire"
  | "cap_archive";

export interface MemoryUpdateLogInput {
  noteId: string;
  agentId?: string | null;
  action: MemoryUpdateAction;
  reason: string;
  fieldsChanged?: string[];
  previousValues?: Record<string, unknown>;
}

const SWEEP_BATCH = 500;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_NOTE_CAP = 500;

/** Fire-and-forget audit write; never blocks or throws into the hot path. */
// MEM-001: audit rows used to land in the ambient DB while the note lived in
// the workspace DB. Thread the workspace opts so audit follows the note.
export function logMemoryUpdate(entry: MemoryUpdateLogInput, opts?: MemoryWorkspaceOpts): void {
  void (async () => {
    try {
      const db = (await resolveMemoryDb(opts)) ?? getDb();
      await db.insert(memoryUpdateLog).values({
        id: randomUUID(),
        agentId: entry.agentId ?? null,
        action: entry.action,
        noteId: entry.noteId,
        timestamp: new Date(),
        reason: entry.reason,
        fieldsChanged: entry.fieldsChanged ?? [],
        previousValues: entry.previousValues ?? {},
      });
    } catch (err) {
      console.error("[MemoryLifecycle] Failed to write memory_update_log:", (err as any)?.message || err);
    }
  })();
}

export function getNoteCap(): number {
  return numEnv("MEM_NOTE_CAP", DEFAULT_NOTE_CAP);
}

/** True while a note's suppress_until still hides it from retrieval (MEM-1a). */
export function isSuppressionActive(
  note: { suppressUntil?: Date | string | null },
  now: number = Date.now(),
): boolean {
  if (!note.suppressUntil) return false;
  const until = new Date(note.suppressUntil).getTime();
  return Number.isFinite(until) && until > now;
}

/**
 * Flip hard-suppressed notes whose suppress_until has elapsed back to active.
 * Standalone function so QUE-2 can port it to a repeatable BullMQ job as-is.
 */
export async function runSuppressionSweep(now: Date = new Date(), opts?: MemoryWorkspaceOpts): Promise<{ flipped: number }> {
  // The sweeper fan-out binds each workspace database via runWithDb, so the
  // ALS handle already selects the right database. An explicit workspace id
  // keeps the same precedence as writes when callers sweep one workspace.
  const db = (await resolveMemoryDb(opts)) ?? getDb();
  const expired = await db.query.agentMemoryNotes.findMany({
    where: and(
      eq(agentMemoryNotes.lifecycleStatus, "suppressed"),
      isNotNull(agentMemoryNotes.suppressUntil),
      lte(agentMemoryNotes.suppressUntil, now),
    ),
    columns: { id: true, agentId: true },
    limit: SWEEP_BATCH,
  });
  if (expired.length === 0) return { flipped: 0 };

  await db
    .update(agentMemoryNotes)
    .set({ lifecycleStatus: "active", suppressUntil: null, updatedAt: now })
    .where(inArray(agentMemoryNotes.id, expired.map((n) => n.id)));

  for (const note of expired) {
    logMemoryUpdate({
      noteId: note.id,
      agentId: note.agentId,
      action: "suppress_expire",
      reason: "suppress_until elapsed (sweep)",
    }, opts);
  }
  return { flipped: expired.length };
}

function activeNotesWhere(agentId: string) {
  return and(
    eq(agentMemoryNotes.agentId, agentId),
    eq(agentMemoryNotes.lifecycleStatus, "active"),
  );
}

/** Archive oldest lowest-importance active notes beyond cap. */
export async function enforceNoteCap(
  agentId: string,
  cap: number = getNoteCap(),
  opts?: MemoryWorkspaceOpts,
): Promise<{ archived: number }> {
  const db = await resolveMemoryDb(opts);
  if (!db) return { archived: 0 };
  const [countRow] = await db
    .select({ value: sqlCount() })
    .from(agentMemoryNotes)
    .where(activeNotesWhere(agentId));
  const total = Number(countRow?.value ?? 0);
  if (total <= cap) return { archived: 0 };

  const overflow = total - cap;
  const victims = await db.query.agentMemoryNotes.findMany({
    where: activeNotesWhere(agentId),
    columns: { id: true },
    orderBy: (table, { asc }) => [asc(table.importanceScore), asc(table.createdAt), asc(table.id)],
    limit: overflow,
  });
  if (victims.length === 0) return { archived: 0 };

  await db
    .update(agentMemoryNotes)
    .set({
      lifecycleStatus: "archived" as const,
      archivedAt: new Date(),
      archiveReason: `note_cap:${cap}`,
      updatedAt: new Date(),
    })
    .where(inArray(agentMemoryNotes.id, victims.map((v) => v.id)));

  for (const victim of victims) {
    logMemoryUpdate({
      noteId: victim.id,
      agentId,
      action: "cap_archive",
      reason: `note_cap:${cap}`,
    });
  }
  return { archived: victims.length };
}

/** Cap safety net across every agent with active notes. */
export async function enforceCapsAllAgents(cap: number = getNoteCap()): Promise<number> {
  const db = getDb();
  const rows = await db.query.agentMemoryNotes.findMany({
    where: eq(agentMemoryNotes.lifecycleStatus, "active"),
    columns: { agentId: true },
  });
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  let archived = 0;
  // ponytail: concurrency 5 via chunks, order-independent sum
  for (let i = 0; i < agentIds.length; i += 5) {
    const chunk = agentIds.slice(i, i + 5);
    const settled = await Promise.allSettled(chunk.map((agentId) => enforceNoteCap(agentId, cap)));
    settled.forEach((r, j) => {
      if (r.status === "fulfilled") archived += r.value.archived;
      else console.error(`[MemoryLifecycle] Cap enforcement failed for ${chunk[j]}:`, (r.reason as any)?.message || r.reason);
    });
  }
  return archived;
}

let started = false;

/** Test-only: clear the once-per-process guard. */
export function resetMemorySweeperForTests(): void {
  started = false;
}

/** Interim timer registration (QUE-2 will move the body to a repeatable job). */
export function startMemorySweeper(): void {
  if (started) return;
  started = true;

  const intervalMs = numEnv("MEM_SUPPRESS_SWEEP_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const tick = async () => {
    // ponytail: sweep every database — memories live per workspace DB.
    await forEachWorkspaceDb(async (db) => {
      await runWithDb(db, async () => {
        try {
          await runSuppressionSweep();
        } catch (err) {
          console.error("[MemoryLifecycle] Suppression sweep failed:", (err as Error)?.message || err);
        }
        try {
          await enforceCapsAllAgents();
        } catch (err) {
          console.error("[MemoryLifecycle] Cap sweep failed:", (err as Error)?.message || err);
        }
      });
    });
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  console.log(`[MemoryLifecycle] Sweeper active every ${intervalMs}ms (cap ${getNoteCap()}).`);
}

/** Soft-suppress a note for MEM_DISCARD_TTL_MS without touching lifecycle. */
export async function softSuppressNote(
  resolvedAgentId: string,
  noteId: string,
  reason: string,
  suppressUntil: Date,
  opts?: MemoryWorkspaceOpts,
): Promise<boolean> {
  const db = await resolveMemoryDb(opts);
  if (!db) return false;
  const existing = await db.query.agentMemoryNotes.findFirst({
    where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
  });
  if (!existing) return false;
  if (existing.lifecycleStatus === "suppressed") return true;

  await db
    .update(agentMemoryNotes)
    .set({
      suppressedAt: new Date(),
      suppressReason: reason,
      suppressUntil,
      updatedAt: new Date(),
    })
    .where(eq(agentMemoryNotes.id, noteId));

  logMemoryUpdate({
    noteId,
    agentId: resolvedAgentId,
    action: "suppress_soft",
    reason,
    fieldsChanged: ["suppressUntil"],
    previousValues: { suppressUntil: existing.suppressUntil },
  });
  return true;
}

/** MEM-2 port: hide a note from previews for this session and soft-suppress it. */
export async function discardNoteFromContext(
  resolvedAgentId: string,
  channelId: string,
  noteId: string,
  reason: string,
  opts?: MemoryWorkspaceOpts,
): Promise<{ ok: true; inVault: boolean }> {
  const ttlMs = numEnv("MEM_DISCARD_TTL_MS", 30 * 60 * 1000);
  // MEM-019: session discards are keyed in the resolved-UUID space so the
  // retrieval read path (which resolves alias inputs the same way) reads back
  // the same key. Dynamic import breaks the store↔lifecycle module cycle;
  // resolution failure keeps the caller-provided id (degraded parity).
  let agentKey = resolvedAgentId;
  try {
    const { resolveAgentId } = await import("./agent-memory-store.js");
    agentKey = await resolveAgentId(resolvedAgentId, opts);
  } catch {
    // keep the caller-provided id
  }
  let inVault = false;
  try {
    inVault = await softSuppressNote(agentKey, noteId, `discard_memory_from_context: ${reason}`, new Date(Date.now() + ttlMs), opts);
  } catch (err) {
    console.error("[MemoryLifecycle] Soft-suppress on discard failed:", (err as any)?.message || err);
  }
  memorySessionDiscards.discard(agentKey, channelId, [noteId], ttlMs);
  return { ok: true, inVault };
}
