import { and, eq } from "drizzle-orm";
import { isConnectionError } from "../shared/config/database.js";
import { agentMemoryNotes } from "../db/schema.js";
import { isSuppressionActive, resolveMemoryDb } from "./memory-lifecycle.js";
import { numEnv } from "./memory-env.js";
import { memorySessionDiscards } from "./memory-session-discards.js";
import { listMemoryPreviews, type MemoryNotePreview } from "./agent-memory-store.js";
import { readLocalMemoryNotes, scoreLocalNote } from "./memory-local-store.js";
import { wrapUntrusted } from "../shared/core/untrusted-wrapper.js";

const DEFAULT_RETRIEVAL_WINDOW = 60;

function retrievalWindowSize(): number {
  return Math.floor(numEnv("MEM_RETRIEVAL_WINDOW", DEFAULT_RETRIEVAL_WINDOW));
}

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
  /** Record-only workspace context: resolves the per-workspace DB handle when present. */
  workspaceId?: string | null;
}

/**
 * Retrieve memory candidates by running multiple lanes in parallel, then
 * merging and deduplicating results. Forked from Continuum's multi-lane
 * retrieval design. SCL-2: semantic embedding lane enabled when
 * EMBEDDING_ENABLED=true — hybrid lane scoring blends vector cosine with
 * heuristic lanes (weight via EMBEDDING_HYBRID_WEIGHT).
 */
export async function retrieveMemoryCandidates(input: RetrievalInput): Promise<MemoryCandidate[]> {
  const discarded = new Set(memorySessionDiscards.listDiscarded(input.agentId, input.channelId));

  // Degraded (§18): no PG — score the local mirror with the naive matcher.
  const db = await resolveMemoryDb({ workspaceId: input.workspaceId });
  if (!db) return retrieveLocalCandidates(input, discarded);
  let notes: MemoryNotePreview[];
  try {
    // PERF-2: bounded hot-path window. Candidate set is capped SQL-side to the
    // top `MEM_RETRIEVAL_WINDOW` (default 60) active notes ranked by the scored
    // proxy (importance_score DESC, note_timestamp DESC); lane scoring and
    // dedupe then run on that bounded set instead of the agent's full history.
    const windowSize = retrievalWindowSize();
    notes = (await db.query.agentMemoryNotes.findMany({
      where: and(
        eq(agentMemoryNotes.agentId, input.agentId),
        eq(agentMemoryNotes.lifecycleStatus, "active"),
      ),
      orderBy: (table, { desc }) => [desc(table.importanceScore), desc(table.noteTimestamp)],
      limit: windowSize,
    }))
      .filter((note) => !isSuppressionActive(note))
      .filter((note) => !discarded.has(note.id));
  } catch (err) {
    if (isConnectionError(err)) return retrieveLocalCandidates(input, discarded);
    throw err;
  }

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

  // SCL-2: hybrid semantic lane — when embeddings are available, blend cosine
  // similarity into the heuristic score. Weight 0 => heuristic only (legacy).
  const embeddingEnabled = String(process.env.EMBEDDING_ENABLED ?? "false").trim().toLowerCase() === "true";
  if (embeddingEnabled && input.userMessageText) {
    try {
      const { embedText, cosineSimilarity, getCachedEmbeddingVector } = await import("./embeddings.js");
      const queryEmbedding = (await embedText(input.userMessageText, { workspaceId: input.workspaceId })).vector;
      const weightRaw = process.env.EMBEDDING_HYBRID_WEIGHT?.trim();
      const weight = weightRaw ? Math.min(1, Math.max(0, Number(weightRaw))) : 0.5;
      if (Number.isFinite(weight) && weight > 0) {
        for (const note of notes) {
          const stored = (note as unknown as { embedding?: unknown }).embedding;
          if (!stored) continue;
          const vec = getCachedEmbeddingVector(note.id, stored);
          if (!vec || vec.length !== queryEmbedding.length) continue;
          const cosine = cosineSimilarity(queryEmbedding, vec);
          const semanticScore = (cosine + 1) / 2; // 0..1
          if (semanticScore > 0.3) {
            const existing = candidates.get(note.id);
            const heuristic = existing?.score ?? 0;
            const hybrid = heuristic * (1 - weight) + semanticScore * weight;
            add(note, "semantic", hybrid);
            // Also update existing candidate's score to hybrid if semantic lane wins
            const cand = candidates.get(note.id);
            if (cand && hybrid > cand.score) cand.score = hybrid;
          }
        }
      }
    } catch {}
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK ?? 10);
}

/** Degraded local candidate search (no lanes, no vectors — naive substring). */
async function retrieveLocalCandidates(input: RetrievalInput, discarded: Set<string>): Promise<MemoryCandidate[]> {
  const rows = (await readLocalMemoryNotes(input.agentId).catch(() => []))
    .filter((r) => r.lifecycleStatus === "active")
    .filter((r) => !discarded.has(r.id));
  return rows
    .map((r) => {
      const score = scoreLocalNote(r, input.userMessageText ?? "");
      return {
        noteId: r.id, hook: r.hook, brief: r.brief, noteType: r.noteType,
        noteTimestamp: new Date(r.noteTimestamp), importanceScore: r.importanceScore,
        confidence: r.confidence, contradictionFlags: r.contradictionFlags ?? [],
        score, laneScores: { local: score }, sourceLanes: ["local"],
      } as MemoryCandidate;
    })
    .filter((c) => c.score > 0.1)
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
    // CTX-2: memory hooks are untrusted — wrap hook/brief individually
    const safeHook = wrapUntrusted("memory", c.hook);
    const safeBrief = wrapUntrusted("memory", c.brief);
    return `[${c.score.toFixed(2)}] "${safeHook}" — "${safeBrief}" {note_id: ${c.noteId}, type: ${c.noteType}, lanes: ${c.sourceLanes.join("|")}, importance: ${c.importanceScore}, has_tension: ${hasTension}}`;
  });

  return `<memory_previews>\n${lines.join("\n")}\n</memory_previews>`;
}
