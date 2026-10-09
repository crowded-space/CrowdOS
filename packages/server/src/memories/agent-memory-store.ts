import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, or, type SQL } from "drizzle-orm";
import { getDb, dbScopeKey, isConnectionError } from "../shared/config/database.js";
import { mirrorMemoryNote, readLocalMemoryNotes } from "./memory-local-store.js";
import {
  agents,
  channels,
  agentMemoryNotes,
} from "../db/schema.js";
import { logMemoryUpdate, enforceNoteCap, isSuppressionActive, resolveMemoryDb, type MemoryWorkspaceOpts } from "./memory-lifecycle.js";
import { reflectionThrottle } from "./memory-reflection-throttle.js";
import { sanitizeReflectionField } from "../shared/core/reflection-sanitizer.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import type { InferSelectModel } from "drizzle-orm";

export type MemoryNoteType =
  | "episodic"
  | "semantic"
  | "reflection"
  | "journal"
  | "tool_result"
  | "correspondence"
  | "tension";

export type MemoryConfidence = "low" | "medium" | "high";

export type MemorySourceType =
  | "direct_experience"
  | "self_reflection"
  | "tool_result"
  | "channel_observation"
  | "entity_testimony";

export type MemoryValence = "positive" | "neutral" | "negative" | "mixed" | "unknown";

export type MemoryLifecycleStatus = "active" | "archived" | "suppressed";

export interface MemoryNotePreview {
  id: string;
  agentId: string;
  channelId: string | null;
  noteType: MemoryNoteType;
  noteTimestamp: Date;
  importanceScore: number;
  confidence: MemoryConfidence;
  sourceType: MemorySourceType;
  emotionalValence: MemoryValence;
  accessCount: number;
  lastAccessed: Date | null;
  links: string[];
  contradictionFlags: string[];
  lifecycleStatus: MemoryLifecycleStatus;
  hook: string;
  brief: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryNoteFull extends MemoryNotePreview {
  observed: string;
  interpreted: string;
  feltSense: string;
  futureRelevance: string;
  uncertainty: string;
  detailed: string;
}

export interface CreateMemoryNoteInput {
  agentId: string;
  channelId: string;
  noteType: MemoryNoteType;
  noteTimestamp?: Date;
  importanceScore?: number;
  confidence?: MemoryConfidence;
  sourceType?: MemorySourceType;
  emotionalValence?: MemoryValence;
  links?: string[];
  hook: string;
  brief: string;
  observed?: string;
  interpreted?: string;
  feltSense?: string;
  futureRelevance?: string;
  uncertainty?: string;
  detailed?: string;
}

export interface UpdateMemoryNotePatch {
  // MEM-006: optional in practice (runtime defaults to 'update'); the
  // required type forced casts on omission.
  reason?: string;
  importanceScore?: number;
  confidence?: MemoryConfidence;
  emotionalValence?: MemoryValence;
  links?: string[];
  contradictionFlags?: string[];
  hook?: string;
  brief?: string;
  observed?: string;
  interpreted?: string;
  feltSense?: string;
  futureRelevance?: string;
  uncertainty?: string;
  detailed?: string;
}

export interface MemoryListFilter {
  noteType?: MemoryNoteType;
  channelId?: string;
  includeArchived?: boolean;
  includeSuppressed?: boolean;
  minImportance?: number;
  limit?: number;
}

export type MemoryStoreError =
  | "AGENT_NOT_FOUND"
  | "NOTE_NOT_FOUND"
  | "INVALID_INPUT"
  | "UPDATE_FAILED"
  | "REFLECTION_THROTTLED"
  | "REFLECTION_DUPLICATE";

export type MemoryStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: MemoryStoreError; message: string } };

type NoteRow = InferSelectModel<typeof agentMemoryNotes>;

function toPreview(note: NoteRow): MemoryNotePreview {
  return {
    id: note.id,
    agentId: note.agentId,
    channelId: note.channelId,
    noteType: note.noteType,
    noteTimestamp: note.noteTimestamp,
    importanceScore: note.importanceScore,
    confidence: note.confidence,
    sourceType: note.sourceType,
    emotionalValence: note.emotionalValence,
    accessCount: note.accessCount,
    lastAccessed: note.lastAccessed,
    links: note.links,
    contradictionFlags: note.contradictionFlags,
    lifecycleStatus: note.lifecycleStatus,
    hook: note.hook,
    brief: note.brief,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function toFull(note: NoteRow): MemoryNoteFull {
  return {
    ...toPreview(note),
    observed: note.observed,
    interpreted: note.interpreted,
    feltSense: note.feltSense,
    futureRelevance: note.futureRelevance,
    uncertainty: note.uncertainty,
    detailed: note.detailed,
  };
}

// ─── Degraded local mirror (§18) ─────────────────────────────────────
// Local rows carry ISO dates; revive to Date for the public shapes.
function localToPreview(note: {
  id: string; agentId: string; channelId: string | null; noteType: string;
  noteTimestamp: string; importanceScore: number; confidence: string;
  sourceType: string; emotionalValence: string; accessCount: number;
  lastAccessed: string | null; links: string[]; contradictionFlags: string[];
  lifecycleStatus: string; hook: string; brief: string; createdAt: string; updatedAt: string;
}): MemoryNotePreview {
  return {
    ...note,
    noteTimestamp: new Date(note.noteTimestamp),
    lastAccessed: note.lastAccessed ? new Date(note.lastAccessed) : null,
    createdAt: new Date(note.createdAt),
    updatedAt: new Date(note.updatedAt),
  } as MemoryNotePreview;
}

function localToFull(note: Parameters<typeof localToPreview>[0] & {
  observed: string; interpreted: string; feltSense: string;
  futureRelevance: string; uncertainty: string; detailed: string;
}): MemoryNoteFull {
  return { ...localToPreview(note), observed: note.observed, interpreted: note.interpreted, feltSense: note.feltSense, futureRelevance: note.futureRelevance, uncertainty: note.uncertainty, detailed: note.detailed };
}

/** Local-only create when PG is unconfigured/unreachable (no FK validation). */
async function createLocalNote(input: CreateMemoryNoteInput, resolvedAgentId: string): Promise<MemoryNotePreview> {
  const now = new Date();
  const id = buildNoteId(now);
  const row = {
    id, agentId: resolvedAgentId, channelId: input.channelId ?? null,
    noteType: input.noteType, noteTimestamp: (input.noteTimestamp ?? now).toISOString(),
    importanceScore: input.importanceScore ?? 0.5, confidence: input.confidence ?? "medium",
    sourceType: input.sourceType ?? "direct_experience", emotionalValence: input.emotionalValence ?? "neutral",
    accessCount: 0, lastAccessed: null, links: input.links ?? [], contradictionFlags: [],
    lifecycleStatus: "active", hook: input.hook, brief: input.brief,
    observed: input.observed ?? "", interpreted: input.interpreted ?? "",
    feltSense: input.feltSense ?? "", futureRelevance: input.futureRelevance ?? "",
    uncertainty: input.uncertainty ?? "", detailed: input.detailed ?? "",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  await mirrorMemoryNote(resolvedAgentId, row);
  return localToPreview(row as Parameters<typeof localToPreview>[0]);
}

/** Resolve a human-readable agent name or slug to its DB UUID. */
const resolveCache = new TtlCache<string>(60_000, 500);
export async function resolveAgentId(agentId: string, opts?: MemoryWorkspaceOpts): Promise<string> {
  if (!agentId) return agentId;
  const cleanId = agentId.trim();
  // Workspace id participates in the key: the same alias may resolve to
  // different rows in different workspace DBs (and "global" covers no scope).
  const cacheKey = `${dbScopeKey()}:${opts?.workspaceId ?? ""}:${cleanId}`;
  const cached = resolveCache.get(cacheKey);
  if (cached) return cached;
  // Degraded (§18): no PG to resolve against — return the id as-given.
  const db = await resolveMemoryDb(opts);
  if (!db) return cleanId;
  const rawName = cleanId.replace(/^@+/, "");

  // 1. Direct ID match
  let byId: { id: string } | undefined;
  try {
    byId = await db.query.agents.findFirst({ where: eq(agents.id, cleanId) });
  } catch (err) {
    if (isConnectionError(err)) return cleanId;
    throw err;
  }
  if (byId) {
    resolveCache.set(cacheKey, byId.id);
    return byId.id;
  }

  // 2. Bounded, case-insensitive match on id/name/title (MEM-009). This used
  // to be a full findMany() scan of the agents table on every uncached alias
  // miss; the WHERE clause + single-row fetch keeps cost independent of table
  // size. `@handle` input forms are preserved via the prefixed pattern.
  const escapeLike = (value: string): string => value.replace(/([\\%_])/g, "\\$1");
  const patternRaw = escapeLike(rawName);
  const patternClean = escapeLike(cleanId);
  let matched: { id: string } | undefined;
  try {
    matched = await db.query.agents.findFirst({
      where: or(
        ilike(agents.id, patternClean),
        ilike(agents.name, patternRaw),
        ilike(agents.name, patternClean),
        ilike(agents.name, escapeLike(`@${rawName}`)),
        ilike(agents.title, patternRaw),
        ilike(agents.title, patternClean),
      ),
    });
  } catch (err) {
    if (isConnectionError(err)) return cleanId;
    throw err;
  }

  if (matched) {
    resolveCache.set(cacheKey, matched.id);
    return matched.id;
  }
  resolveCache.set(cacheKey, cleanId);
  return cleanId;
}

/**
 * Generate a unique note ID in the Continuum lineage format:
 * YYYY-MM-DD-<suffix>, where the suffix is 12 hex chars from a UUID.
 * Collision space (~2^48/day) makes table scans unnecessary; the insert retry
 * loop in createMemoryNote covers the negligible collision case.
 */
export function buildNoteId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${yyyy}-${mm}-${dd}-${suffix}`;
}

export async function generateNoteId(_agentId?: string): Promise<string> {
  return buildNoteId();
}

export async function createMemoryNote(
  input: CreateMemoryNoteInput,
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const resolvedAgentId = await resolveAgentId(input.agentId, opts).catch(() => input.agentId.trim());
  // Degraded (§18): no PG — local-only note, no FK validation.
  const db = await resolveMemoryDb(opts);
  if (!db) {
    return { ok: true, value: await createLocalNote(input, resolvedAgentId) };
  }
  let agent: unknown;
  let channel: unknown;
  try {
    [agent, channel] = await Promise.all([
      db.query.agents.findFirst({ where: eq(agents.id, resolvedAgentId) }),
      input.channelId
        ? db.query.channels.findFirst({ where: eq(channels.id, input.channelId) })
        : Promise.resolve(null),
    ]);
  } catch (err) {
    if (isConnectionError(err)) return { ok: true, value: await createLocalNote(input, resolvedAgentId) };
    throw err;
  }
  if (!agent) {
    return { ok: false, error: { code: "AGENT_NOT_FOUND", message: `Agent not found: ${input.agentId}` } };
  }

  // Validate channelId: if non-existent or invalid, fallback to null to avoid foreign key errors
  const validChannelId: string | null = (channel as { id?: string } | null)?.id ?? null;

  const noteTimestamp = input.noteTimestamp ?? new Date();

  const isAutoReflection = input.noteType === "reflection" && input.sourceType === "self_reflection";
  if (isAutoReflection) {
    // CTX-2 provenance + control/block stripping before throttle check so dedupe sees sanitized form
    input.hook = sanitizeReflectionField(input.hook);
    input.brief = sanitizeReflectionField(input.brief);
    if (input.observed) input.observed = sanitizeReflectionField(input.observed);
    if (input.interpreted) input.interpreted = sanitizeReflectionField(input.interpreted);
    if (input.feltSense) input.feltSense = sanitizeReflectionField(input.feltSense);
    if (input.futureRelevance) input.futureRelevance = sanitizeReflectionField(input.futureRelevance);
    if (input.uncertainty) input.uncertainty = sanitizeReflectionField(input.uncertainty);
    if (input.detailed) input.detailed = sanitizeReflectionField(input.detailed);
    const verdict = reflectionThrottle.check(resolvedAgentId, input.hook);
    if (!verdict.allowed) {
      return {
        ok: false,
        error: {
          code: verdict.reason === "duplicate_hook" ? "REFLECTION_DUPLICATE" : "REFLECTION_THROTTLED",
          message:
            verdict.reason === "duplicate_hook"
              ? "Reflection note deduplicated: a recent note has a similar hook."
              : "Reflection note throttled: min interval between reflection writes not elapsed.",
        },
      };
    }
  }

  // Retry up to 3 times in case of ID collision
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = await generateNoteId(resolvedAgentId);
      const [inserted] = await db
        .insert(agentMemoryNotes)
        .values({
          id,
          agentId: resolvedAgentId,
          channelId: validChannelId,
          noteType: input.noteType,
          noteTimestamp,
          importanceScore: input.importanceScore ?? 0.5,
          confidence: input.confidence ?? "medium",
          sourceType: input.sourceType ?? "direct_experience",
          emotionalValence: input.emotionalValence ?? "neutral",
          links: input.links ?? [],
          hook: input.hook,
          brief: input.brief,
          observed: input.observed ?? "",
          interpreted: input.interpreted ?? "",
          feltSense: input.feltSense ?? "",
          futureRelevance: input.futureRelevance ?? "",
          uncertainty: input.uncertainty ?? "",
          detailed: input.detailed ?? "",
        })
        .returning();

      if (isAutoReflection) reflectionThrottle.record(resolvedAgentId, input.hook);

      logMemoryUpdate({
        noteId: id,
        agentId: resolvedAgentId,
        action: "create",
        reason: "created",
        fieldsChanged: ["noteType", "hook", "brief"],
      }, opts);

      void enforceNoteCap(resolvedAgentId, undefined, opts).catch((err) => {
        console.error("[MemoryStore] Note-cap enforcement failed:", (err as any)?.message || err);
      });

      // Best-effort local mirror for degraded reads (never fails the write).
      await mirrorMemoryNote(resolvedAgentId, inserted as unknown as Record<string, unknown>).catch((err) => {
        console.warn("[MemoryStore] local mirror failed:", (err as Error)?.message || err);
      });

      return { ok: true, value: toPreview(inserted) };
    } catch (err: any) {
      if (isConnectionError(err)) return { ok: true, value: await createLocalNote(input, resolvedAgentId) };
      // MEM-012: only id-collision errors merit a retry. A deterministic
      // error (bad enum, FK, validation) used to burn 3 attempts before
      // surfacing; rethrow immediately unless it looks like a collision.
      const code = (err as { code?: string })?.code;
      const isCollision = code === "23505" || /already exists|duplicate|unique/i.test(err?.message ?? "");
      if (!isCollision) throw err;
      // Collision budget exhausted: fall through to the documented
      // UPDATE_FAILED result instead of the previously unreachable return.
      if (attempt === 2) break;
    }
  }

  return { ok: false, error: { code: "UPDATE_FAILED", message: "Failed to allocate a unique memory note ID." } };
}

/** Patch the local mirror (degraded updates). Returns null when missing. */
async function patchLocalNote(agentId: string, noteId: string, patch: Record<string, unknown>): Promise<MemoryNotePreview | null> {
  const rows = await readLocalMemoryNotes(agentId).catch(() => []);
  const found = rows.find((r) => r.id === noteId);
  if (!found) return null;
  const next = { ...found, ...patch, updatedAt: new Date().toISOString() };
  await mirrorMemoryNote(agentId, next as unknown as Record<string, unknown>);
  return localToPreview(next as Parameters<typeof localToPreview>[0]);
}

export async function readMemoryNote(
  agentId: string,
  noteId: string,
  options?: { updateAccess?: boolean },
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNoteFull>> {
  const resolvedAgentId = await resolveAgentId(agentId, opts).catch(() => agentId.trim());
  const readLocal = async (): Promise<MemoryStoreResult<MemoryNoteFull>> => {
    const rows = await readLocalMemoryNotes(resolvedAgentId).catch(() => []);
    const found = rows.find((r) => r.id === noteId);
    if (!found) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: localToFull(found as Parameters<typeof localToFull>[0]) };
  };
  const db = await resolveMemoryDb(opts);
  if (!db) return readLocal();
  let note;
  try {
    note = await db.query.agentMemoryNotes.findFirst({
      where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
    });
  } catch (err) {
    if (isConnectionError(err)) return readLocal();
    throw err;
  }
  if (!note) {
    return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
  }

  if (options?.updateAccess !== false) {
    try {
      await db
        .update(agentMemoryNotes)
        .set({ accessCount: note.accessCount + 1, lastAccessed: new Date() })
        .where(eq(agentMemoryNotes.id, noteId));
    } catch (err) {
      if (!isConnectionError(err)) throw err;
    }
  }

  return { ok: true, value: toFull(note) };
}

export async function listMemoryPreviews(
  agentId: string,
  filter: MemoryListFilter = {},
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNotePreview[]>> {
  const resolvedAgentId = await resolveAgentId(agentId, opts).catch(() => agentId.trim());
  const listLocal = async (): Promise<MemoryStoreResult<MemoryNotePreview[]>> => {
    let rows = await readLocalMemoryNotes(resolvedAgentId).catch(() => []);
    if (!filter.includeArchived && !filter.includeSuppressed) rows = rows.filter((r) => r.lifecycleStatus === "active");
    else if (filter.includeArchived && !filter.includeSuppressed) rows = rows.filter((r) => r.lifecycleStatus !== "suppressed");
    else if (!filter.includeArchived && filter.includeSuppressed) rows = rows.filter((r) => r.lifecycleStatus !== "archived");
    if (filter.noteType) rows = rows.filter((r) => r.noteType === filter.noteType);
    if (filter.channelId) rows = rows.filter((r) => r.channelId === filter.channelId);
    if (filter.minImportance != null) rows = rows.filter((r) => r.importanceScore >= filter.minImportance!);
    rows = rows.slice().sort((a, b) => b.importanceScore - a.importanceScore || (a.noteTimestamp < b.noteTimestamp ? 1 : -1));
    const limit = filter.limit ?? 50;
    return { ok: true, value: rows.slice(0, limit).map((r) => localToPreview(r as Parameters<typeof localToPreview>[0])) };
  };
  const db = await resolveMemoryDb(opts);
  if (!db) return listLocal();

  const conditions: SQL[] = [eq(agentMemoryNotes.agentId, resolvedAgentId)];

  let lifecycle: SQL | undefined;
  if (filter.includeArchived && filter.includeSuppressed) {
    lifecycle = undefined;
  } else if (filter.includeArchived) {
    lifecycle = or(
      eq(agentMemoryNotes.lifecycleStatus, "active"),
      eq(agentMemoryNotes.lifecycleStatus, "archived"),
    );
  } else if (filter.includeSuppressed) {
    lifecycle = or(
      eq(agentMemoryNotes.lifecycleStatus, "active"),
      eq(agentMemoryNotes.lifecycleStatus, "suppressed"),
    );
  } else {
    lifecycle = eq(agentMemoryNotes.lifecycleStatus, "active");
  }
  if (lifecycle) conditions.push(lifecycle);

  if (filter.noteType) conditions.push(eq(agentMemoryNotes.noteType, filter.noteType));
  if (filter.channelId) conditions.push(eq(agentMemoryNotes.channelId, filter.channelId));
  if (filter.minImportance != null) conditions.push(gte(agentMemoryNotes.importanceScore, filter.minImportance));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  let notes;
  try {
    notes = await db.query.agentMemoryNotes.findMany({
      where,
      orderBy: (table, { desc }) => [desc(table.importanceScore), desc(table.noteTimestamp)],
      // MEM-010: clamp previews (was unbounded materialization).
      limit: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    });
  } catch (err) {
    if (isConnectionError(err)) return listLocal();
    throw err;
  }

  const visible = filter.includeSuppressed
    ? notes
    : notes.filter((n) => !isSuppressionActive(n));

  return { ok: true, value: visible.map(toPreview) };
}

export async function updateMemoryNote(
  agentId: string,
  noteId: string,
  patch: UpdateMemoryNotePatch,
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const resolvedAgentId = await resolveAgentId(agentId, opts).catch(() => agentId.trim());
  const updateLocal = async (patchFields: Record<string, unknown>): Promise<MemoryStoreResult<MemoryNotePreview>> => {
    const updated = await patchLocalNote(resolvedAgentId, noteId, patchFields);
    if (!updated) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: updated };
  };
  const db = await resolveMemoryDb(opts);
  if (!db) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== "reason") fields[k] = v;
    return updateLocal(fields);
  }
  let existing;
  try {
    existing = await db.query.agentMemoryNotes.findFirst({
      where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
    });
  } catch (err) {
    if (isConnectionError(err)) {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== "reason") fields[k] = v;
      return updateLocal(fields);
    }
    throw err;
  }
  if (!existing) {
    return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
  }

  const editableKeys: Array<keyof UpdateMemoryNotePatch> = [
    "importanceScore",
    "confidence",
    "emotionalValence",
    "links",
    "contradictionFlags",
    "hook",
    "brief",
    "observed",
    "interpreted",
    "feltSense",
    "futureRelevance",
    "uncertainty",
    "detailed",
  ];

  const fieldsChanged: string[] = [];
  const previousValues: Record<string, unknown> = {};
  const set: Partial<NoteRow> = {};

  for (const key of editableKeys) {
    const value = patch[key];
    if (value !== undefined) {
      fieldsChanged.push(key);
      previousValues[key] = (existing as Record<string, unknown>)[key as string];
      (set as Record<string, unknown>)[key as string] = value;
    }
  }

  if (fieldsChanged.length === 0) {
    return { ok: true, value: toPreview(existing) };
  }

  set.updatedAt = new Date();

  const [updated] = await db
    .update(agentMemoryNotes)
    .set(set)
    .where(eq(agentMemoryNotes.id, noteId))
    .returning();

  logMemoryUpdate({
    noteId,
    agentId: resolvedAgentId,
    action: "update",
    reason: patch.reason ?? "update",
    fieldsChanged,
    previousValues,
  }, opts);

  await mirrorMemoryNote(resolvedAgentId, updated as unknown as Record<string, unknown>).catch(() => {});

  return { ok: true, value: toPreview(updated) };
}

export async function archiveMemoryNote(
  agentId: string,
  noteId: string,
  reason: string,
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const resolvedAgentId = await resolveAgentId(agentId, opts).catch(() => agentId.trim());
  const db = await resolveMemoryDb(opts);
  if (!db) {
    const updated = await patchLocalNote(resolvedAgentId, noteId, { lifecycleStatus: "archived", archiveReason: reason });
    if (!updated) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: updated };
  }
  let existing;
  try {
    existing = await db.query.agentMemoryNotes.findFirst({
      where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
    });
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const updated = await patchLocalNote(resolvedAgentId, noteId, { lifecycleStatus: "archived", archiveReason: reason });
    if (!updated) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: updated };
  }
  if (!existing) {
    return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
  }

  const [updated] = await db
    .update(agentMemoryNotes)
    .set({
      lifecycleStatus: "archived",
      archivedAt: new Date(),
      archiveReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(agentMemoryNotes.id, noteId))
    .returning();

  logMemoryUpdate({
    noteId,
    agentId: resolvedAgentId,
    action: "archive",
    reason,
    fieldsChanged: ["lifecycleStatus"],
    previousValues: { lifecycleStatus: existing.lifecycleStatus },
  }, opts);

  await mirrorMemoryNote(resolvedAgentId, updated as unknown as Record<string, unknown>).catch(() => {});

  return { ok: true, value: toPreview(updated) };
}

export async function suppressMemoryNote(
  agentId: string,
  noteId: string,
  reason: string,
  suppressUntil: Date,
  opts?: MemoryWorkspaceOpts,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const resolvedAgentId = await resolveAgentId(agentId, opts).catch(() => agentId.trim());
  const db = await resolveMemoryDb(opts);
  if (!db) {
    const updated = await patchLocalNote(resolvedAgentId, noteId, { lifecycleStatus: "suppressed", suppressReason: reason, suppressUntil: suppressUntil.toISOString() });
    if (!updated) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: updated };
  }
  let existing;
  try {
    existing = await db.query.agentMemoryNotes.findFirst({
      where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
    });
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const updated = await patchLocalNote(resolvedAgentId, noteId, { lifecycleStatus: "suppressed", suppressReason: reason, suppressUntil: suppressUntil.toISOString() });
    if (!updated) return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
    return { ok: true, value: updated };
  }
  if (!existing) {
    return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
  }

  const [updated] = await db
    .update(agentMemoryNotes)
    .set({
      lifecycleStatus: "suppressed",
      suppressedAt: new Date(),
      suppressReason: reason,
      suppressUntil,
      updatedAt: new Date(),
    })
    .where(eq(agentMemoryNotes.id, noteId))
    .returning();

  logMemoryUpdate({
    noteId,
    agentId: resolvedAgentId,
    action: "suppress",
    reason,
    fieldsChanged: ["lifecycleStatus", "suppressUntil"],
    previousValues: { lifecycleStatus: existing.lifecycleStatus },
  }, opts);

  await mirrorMemoryNote(resolvedAgentId, updated as unknown as Record<string, unknown>).catch(() => {});

  return { ok: true, value: toPreview(updated) };
}
