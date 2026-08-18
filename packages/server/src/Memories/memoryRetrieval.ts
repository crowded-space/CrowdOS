import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { agentMemoryNotes } from "../db/schema.js";
import { listMemoryPreviews, type MemoryNotePreview } from "./agentMemoryStore.js";

export interface MemoryCandidate {
  noteId: string;
  hook: string;
  brief: string;
  noteType: string;
  noteTimestamp: Date;
  importanceScore: number;
  confidence: string;
  contradictionFlags: string[];
  score: number;
  laneScores: Record<string, number>;
  sourceLanes: string[];
}

export interface RetrievalInput {
  agentId: string;
  channelId: string;
  userMessageText: string;
  recentEpisodic: boolean;
  highImportance: boolean;
  mentions: boolean;
  unresolvedTensions: boolean;
  recencyBump: boolean;
  topK: number;
}

/**
 * Retrieve memory candidates by running multiple lanes in parallel, then
 * merging and deduplicating results. Forked from Continuum's multi-lane
 * retrieval design. Semantic embedding lanes are stubbed and can be wired to
 * pgvector later.
 */
export async function retrieveMemoryCandidates(input: RetrievalInput): Promise<MemoryCandidate[]> {
  const db = getDb();

  const notes = await db.query.agentMemoryNotes.findMany({
    where: and(
      eq(agentMemoryNotes.agentId, input.agentId),
      eq(agentMemoryNotes.lifecycleStatus, "active"),
    ),
    orderBy: (table, { desc }) => [desc(table.noteTimestamp)],
  });

  const candidates = new Map<string, MemoryCandidate>();

  const add = (note: MemoryNotePreview, lane: string, score: number) => {
    const existing = candidates.get(note.id);
    if (existing) {
      existing.laneScores[lane] = Math.max(existing.laneScores[lane] ?? 0, score);
      if (!existing.sourceLanes.includes(lane)) existing.sourceLanes.push(lane);
      existing.score = Math.max(existing.score, score);
    } else {
      candidates.set(note.id, {
        noteId: note.id,
        hook: note.hook,
        brief: note.brief,
        noteType: note.noteType,
        noteTimestamp: note.noteTimestamp,
        importanceScore: note.importanceScore,
        confidence: note.confidence,
        contradictionFlags: note.contradictionFlags,
        score,
        laneScores: { [lane]: score },
        sourceLanes: [lane],
      });
    }
  };

  for (const note of notes) {
    if (input.recentEpisodic && note.noteType === "episodic") {
      add(note, "recent_episodic", 1.0);
    }
    if (input.highImportance && note.importanceScore >= 0.7) {
      add(note, "high_importance", 0.8);
    }
    if (input.mentions && (note.links?.length ?? 0) > 0) {
      add(note, "mentions", 0.6);
    }
    if (input.unresolvedTensions && (note.contradictionFlags?.length ?? 0) > 0) {
      add(note, "unresolved_tensions", 0.9);
    }
    if (input.recencyBump) {
      const ageDays = (Date.now() - new Date(note.noteTimestamp).getTime()) / 86_400_000;
      if (ageDays < 2) {
        add(note, "recency", 0.5);
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK ?? 10);
}

/**
 * Format memory candidates into a compact XML-like preview block suitable for
 * injection into an agent's prompt context. Format mirrors Continuum's memory
 * preview spec: [score] "Hook" — "Brief" {note_id, type, lanes, importance, has_tension}
 */
export function buildMemoryPreviewBlock(candidates: MemoryCandidate[]): string {
  if (!candidates || candidates.length === 0) return "";

  const lines = candidates.map((c) => {
    const hasTension = (c.contradictionFlags?.length ?? 0) > 0;
    return `[${c.score.toFixed(2)}] "${c.hook}" — "${c.brief}" {note_id: ${c.noteId}, type: ${c.noteType}, lanes: ${c.sourceLanes.join("|")}, importance: ${c.importanceScore}, has_tension: ${hasTension}}`;
  });

  return `<memory_previews>\n${lines.join("\n")}\n</memory_previews>`;
}
