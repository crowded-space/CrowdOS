import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, or, type SQL } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import {
  agents,
  agentMemoryNotes,
  memoryUpdateLog,
} from "../db/schema.js";
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
  reason: string;
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
  | "UPDATE_FAILED";

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

/** Resolve a human-readable agent name or slug to its DB UUID. */
export async function resolveAgentId(agentId: string): Promise<string> {
  const db = getDb();
  const byId = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (byId) return byId.id;
  const byName = await db.query.agents.findFirst({
    where: or(eq(agents.name, agentId), eq(agents.name, `@${agentId}`), eq(agents.title, agentId)),
  });
  if (byName) return byName.id;
  return agentId;
}

/** Generate a unique note ID in the Continuum format: YYYY-MM-DD-NNN */
export async function generateNoteId(agentId: string): Promise<string> {
  const db = getDb();
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const datePrefix = `${yyyy}-${mm}-${dd}`;
  const existing = await db.query.agentMemoryNotes.findMany({
    where: eq(agentMemoryNotes.agentId, agentId),
  });
  const todaysCount = existing.filter((n) => n.id.startsWith(datePrefix)).length;
  return `${datePrefix}-${String(todaysCount + 1).padStart(3, "0")}`;
}

export async function createMemoryNote(
  input: CreateMemoryNoteInput,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(input.agentId);
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, resolvedAgentId) });
  if (!agent) {
    return { ok: false, error: { code: "AGENT_NOT_FOUND", message: `Agent not found: ${input.agentId}` } };
  }

  const id = await generateNoteId(resolvedAgentId);
  const noteTimestamp = input.noteTimestamp ?? new Date();

  const [inserted] = await db
    .insert(agentMemoryNotes)
    .values({
      id,
      agentId: resolvedAgentId,
      channelId: input.channelId ?? null,
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

  return { ok: true, value: toPreview(inserted) };
}

export async function readMemoryNote(
  agentId: string,
  noteId: string,
  options?: { updateAccess?: boolean },
): Promise<MemoryStoreResult<MemoryNoteFull>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(agentId);
  const note = await db.query.agentMemoryNotes.findFirst({
    where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
  });
  if (!note) {
    return { ok: false, error: { code: "NOTE_NOT_FOUND", message: `Memory note not found: ${noteId}` } };
  }

  if (options?.updateAccess !== false) {
    await db
      .update(agentMemoryNotes)
      .set({ accessCount: note.accessCount + 1, lastAccessed: new Date() })
      .where(eq(agentMemoryNotes.id, noteId));
  }

  return { ok: true, value: toFull(note) };
}

export async function listMemoryPreviews(
  agentId: string,
  filter: MemoryListFilter = {},
): Promise<MemoryStoreResult<MemoryNotePreview[]>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(agentId);

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
  const notes = await db.query.agentMemoryNotes.findMany({
    where,
    orderBy: (table, { desc }) => [desc(table.importanceScore), desc(table.noteTimestamp)],
    limit: filter.limit ?? 50,
  });

  return { ok: true, value: notes.map(toPreview) };
}

export async function updateMemoryNote(
  agentId: string,
  noteId: string,
  patch: UpdateMemoryNotePatch,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(agentId);
  const existing = await db.query.agentMemoryNotes.findFirst({
    where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
  });
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

  await db.insert(memoryUpdateLog).values({
    id: randomUUID(),
    noteId,
    timestamp: new Date(),
    reason: patch.reason ?? "update",
    fieldsChanged,
    previousValues,
  });

  return { ok: true, value: toPreview(updated) };
}

export async function archiveMemoryNote(
  agentId: string,
  noteId: string,
  reason: string,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(agentId);
  const existing = await db.query.agentMemoryNotes.findFirst({
    where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
  });
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

  await db.insert(memoryUpdateLog).values({
    id: randomUUID(),
    noteId,
    timestamp: new Date(),
    reason,
    fieldsChanged: ["lifecycleStatus"],
    previousValues: { lifecycleStatus: existing.lifecycleStatus },
  });

  return { ok: true, value: toPreview(updated) };
}

export async function suppressMemoryNote(
  agentId: string,
  noteId: string,
  reason: string,
  suppressUntil: Date,
): Promise<MemoryStoreResult<MemoryNotePreview>> {
  const db = getDb();
  const resolvedAgentId = await resolveAgentId(agentId);
  const existing = await db.query.agentMemoryNotes.findFirst({
    where: and(eq(agentMemoryNotes.id, noteId), eq(agentMemoryNotes.agentId, resolvedAgentId)),
  });
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

  await db.insert(memoryUpdateLog).values({
    id: randomUUID(),
    noteId,
    timestamp: new Date(),
    reason,
    fieldsChanged: ["lifecycleStatus"],
    previousValues: { lifecycleStatus: existing.lifecycleStatus },
  });

  return { ok: true, value: toPreview(updated) };
}
