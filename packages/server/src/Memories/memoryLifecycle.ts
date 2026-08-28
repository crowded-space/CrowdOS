import { randomUUID } from "node:crypto";
import { and, count as sqlCount, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { agentMemoryNotes, memoryUpdateLog } from "../db/schema.js";
import { numEnv } from "./memoryEnv.js";
import { memorySessionDiscards } from "./memorySessionDiscards.js";

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
export function logMemoryUpdate(entry: MemoryUpdateLogInput): void {
  void (async () => {
    try {
      await getDb().insert(memoryUpdateLog).values({
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
export async function runSuppressionSweep(now: Date = new Date()): Promise<{ flipped: number }> {
  const db = getDb();
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
    });
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
): Promise<{ archived: number }> {
  const db = getDb();
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
  for (const agentId of agentIds) {
    try {
      archived += (await enforceNoteCap(agentId, cap)).archived;
    } catch (err) {
      console.error(`[MemoryLifecycle] Cap enforcement failed for ${agentId}:`, (err as any)?.message || err);
    }
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
    try {
      await runSuppressionSweep();
    } catch (err) {
      console.error("[MemoryLifecycle] Suppression sweep failed:", (err as any)?.message || err);
    }
    try {
      await enforceCapsAllAgents();
    } catch (err) {
      console.error("[MemoryLifecycle] Cap sweep failed:", (err as any)?.message || err);
    }
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
): Promise<boolean> {
  const db = getDb();
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
): Promise<{ ok: true; inVault: boolean }> {
  const ttlMs = numEnv("MEM_DISCARD_TTL_MS", 30 * 60 * 1000);
  let inVault = false;
  try {
    inVault = await softSuppressNote(resolvedAgentId, noteId, `discard_memory_from_context: ${reason}`, new Date(Date.now() + ttlMs));
  } catch (err) {
    console.error("[MemoryLifecycle] Soft-suppress on discard failed:", (err as any)?.message || err);
  }
  memorySessionDiscards.discard(resolvedAgentId, channelId, [noteId], ttlMs);
  return { ok: true, inVault };
}
