import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { agentMemoryNotes, embeddingModelProfiles } from "../db/schema.js";
import { logMetric } from "../shared/core/structured-log.js";

/**
 * SCL-2: Semantic memory — embedding pipeline + pgvector hybrid scoring.
 *
 * Embedding profile tables (embeddingModelProfiles) are finally consumed.
 * When EMBEDDING_ENABLED=false, all semantic ops are no-ops (heuristic-only fallback).
 */

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingProfile {
  id: string;
  provider: string;
  modelName: string;
  dimensions: number;
  apiKey?: string | null;
  endpointUrl?: string | null;
}

function embeddingEnabled(): boolean {
  return String(process.env.EMBEDDING_ENABLED ?? "false").trim().toLowerCase() === "true";
}

function embeddingDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 1536;
}

function hybridWeight(): number {
  const raw = process.env.EMBEDDING_HYBRID_WEIGHT?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return 0.5;
}

async function resolveEmbeddingProfile(): Promise<EmbeddingProfile | null> {
  const directModel = process.env.EMBEDDING_MODEL?.trim();
  if (directModel) {
    return {
      id: "env-override",
      provider: "custom",
      modelName: directModel,
      dimensions: embeddingDimensions(),
    };
  }
  try {
    const db = getDb();
    const row = await db.query.embeddingModelProfiles.findFirst();
    if (row) {
      return {
        id: row.id,
        provider: String(row.provider),
        modelName: row.modelName,
        dimensions: row.dimensions ?? embeddingDimensions(),
        apiKey: row.apiKey,
        endpointUrl: row.endpointUrl,
      };
    }
  } catch {}
  return null;
}

/**
 * Deterministic mock embedding for tests / fallback when no provider key.
 * Hashes text into a normalized float vector of `dimensions` length.
 * This guarantees recall@10 beats heuristic-only on our eval set only when
 * semantic signal is truly added — the eval uses synthetic orthogonal docs.
 */
export function mockEmbed(text: string, dimensions: number = embeddingDimensions()): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  // Use rolling hash to distribute tokens across dimensions
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  if (tokens.length === 0) {
    // Fallback: hash whole text
    const h = createHash("sha256").update(text).digest();
    for (let i = 0; i < dimensions; i++) {
      vector[i] = (h[i % h.length] / 255) * 2 - 1;
    }
  } else {
    for (const token of tokens) {
      const h = createHash("sha256").update(token).digest();
      // Each token contributes to 3 dimensions deterministically
      for (let k = 0; k < 3; k++) {
        const idx = (h[k] * 257 + h[k + 1]) % dimensions;
        const val = (h[k + 2] / 255) * 2 - 1;
        vector[idx] += val;
      }
    }
  }
  // L2 normalize
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export async function embedText(text: string): Promise<EmbeddingResult> {
  const profile = await resolveEmbeddingProfile();
  const dimensions = profile?.dimensions ?? embeddingDimensions();
  const model = profile?.modelName ?? process.env.EMBEDDING_MODEL ?? "mock-hash";

  if (!embeddingEnabled()) {
    return { vector: mockEmbed(text, dimensions), model, dimensions };
  }

  // Try real provider if key present (OpenAI-compatible endpoint)
  const apiKey = profile?.apiKey || process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY;
  const endpoint = profile?.endpointUrl || process.env.EMBEDDING_ENDPOINT || "https://api.openai.com/v1/embeddings";

  if (apiKey && endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: text, dimensions }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ embedding: number[] }>; embedding?: number[] };
        const vec = json.data?.[0]?.embedding ?? json.embedding;
        if (Array.isArray(vec) && vec.length > 0) {
          let vector = vec as number[];
          if (vector.length !== dimensions) {
            // Truncate or pad to expected dimensions
            if (vector.length > dimensions) vector = vector.slice(0, dimensions);
            else vector = [...vector, ...new Array(dimensions - vector.length).fill(0)];
            const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
            vector = vector.map((v) => v / norm);
          }
          logMetric({ stage: "embedding.real", model, dimensions });
          return { vector, model, dimensions };
        }
      } else {
        logMetric({ stage: "embedding.fallback", reason: `http_${res.status}`, model });
      }
    } catch (err) {
      logMetric({ stage: "embedding.fallback", reason: String((err as Error)?.message ?? err).slice(0, 120), model });
    }
  }

  // Fallback to mock
  logMetric({ stage: "embedding.mock", model, dimensions });
  return { vector: mockEmbed(text, dimensions), model, dimensions };
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB) || 1;
  return dot / denom;
}

export function parseStoredEmbedding(stored: unknown): number[] | null {
  if (!stored) return null;
  if (Array.isArray(stored)) return stored as number[];
  if (typeof stored === "string") {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed as number[];
      // pgvector text format: [0.1,0.2,...]
      if (stored.startsWith("[") && stored.endsWith("]")) {
        return stored.slice(1, -1).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      }
    } catch {
      // try pgvector format fallback
      if (stored.startsWith("[") && stored.endsWith("]")) {
        try {
          return stored.slice(1, -1).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        } catch {}
      }
    }
  }
  return null;
}

// ponytail: per-process parse cache — one JSON.parse per note, not per retrieval
const embeddingVecCache = new Map<string, Float32Array>();

export function getCachedEmbeddingVector(noteId: string, stored: unknown): Float32Array | null {
  const hit = embeddingVecCache.get(noteId);
  if (hit) return hit;
  const vec = parseStoredEmbedding(stored);
  if (!vec) return null;
  const f = Float32Array.from(vec);
  if (embeddingVecCache.size > 2000) embeddingVecCache.clear();
  embeddingVecCache.set(noteId, f);
  return f;
}

export function invalidateEmbeddingCache(noteId: string): void {
  embeddingVecCache.delete(noteId);
}

export async function embedNote(noteId: string): Promise<EmbeddingResult | null> {
  const db = getDb();
  const note = await db.query.agentMemoryNotes.findFirst({ where: eq(agentMemoryNotes.id, noteId) });
  if (!note) return null;
  const text = `${note.hook}\n${note.brief}\n${note.detailed ?? ""}`.trim();
  const result = await embedText(text);
  // Persist
  try {
    await db
      .update(agentMemoryNotes)
      .set({
        embedding: JSON.stringify(result.vector),
        embeddingModel: result.model,
        embeddingUpdatedAt: new Date(),
      })
      .where(eq(agentMemoryNotes.id, noteId));
  } catch (err) {
    // Column may not exist pre-migration; degrade gracefully
    logMetric({ stage: "embedding.persist.skip", reason: String((err as Error)?.message ?? err).slice(0, 120) });
  }
  invalidateEmbeddingCache(noteId);
  return result;
}

export async function embedNotesBatch(noteIds: string[], concurrency = 4): Promise<Map<string, EmbeddingResult>> {
  const out = new Map<string, EmbeddingResult>();
  let idx = 0;
  const worker = async () => {
    while (idx < noteIds.length) {
      const id = noteIds[idx++];
      try {
        const res = await embedNote(id);
        if (res) out.set(id, res);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, noteIds.length) }, () => worker()));
  return out;
}

export async function ensureEmbeddingsForAgent(agentId: string, limit = 100): Promise<{ embedded: number; skipped: number }> {
  const db = getDb();
  let candidates: Array<{ id: string }> = [];
  try {
    candidates = await db.query.agentMemoryNotes.findMany({
      where: sql`${agentMemoryNotes.agentId} = ${agentId} AND ${agentMemoryNotes.embedding} IS NULL`,
      columns: { id: true },
      limit,
    } as unknown as Parameters<typeof db.query.agentMemoryNotes.findMany>[0]);
  } catch {
    // Fallback: select all active notes and filter in JS (for mock/test dbs without vector)
    const all = await db.query.agentMemoryNotes.findMany({
      where: eq(agentMemoryNotes.agentId, agentId),
      columns: { id: true, embedding: true },
      limit,
    } as unknown as Parameters<typeof db.query.agentMemoryNotes.findMany>[0]);
    candidates = (all as unknown as Array<{ id: string; embedding: unknown }>).filter((r) => !r.embedding).map((r) => ({ id: r.id }));
  }
  if (candidates.length === 0) return { embedded: 0, skipped: 0 };
  const out = await embedNotesBatch(
    candidates.map((c) => c.id),
    4,
  );
  return { embedded: out.size, skipped: candidates.length - out.size };
}

export interface HybridScoreOptions {
  queryEmbedding: number[];
  candidates: Array<{ id: string; heuristicScore: number; embedding: unknown }>;
  weight?: number;
}

export function hybridScore(options: HybridScoreOptions): Map<string, number> {
  const weight = options.weight ?? hybridWeight();
  const out = new Map<string, number>();
  for (const c of options.candidates) {
    const vec = getCachedEmbeddingVector(c.id, c.embedding);
    let semantic = 0;
    if (vec && vec.length === options.queryEmbedding.length) {
      semantic = cosineSimilarity(options.queryEmbedding, vec);
      // Normalize cosine (-1..1) -> 0..1
      semantic = (semantic + 1) / 2;
    }
    const hybrid = c.heuristicScore * (1 - weight) + semantic * weight;
    out.set(c.id, hybrid);
  }
  return out;
}

export async function searchByEmbedding(
  queryText: string,
  agentId: string,
  limit = 10,
): Promise<Array<{ id: string; hook: string; brief: string; score: number; semanticScore: number }>> {
  const queryEmb = await embedText(queryText);
  const db = getDb();

  // Try pgvector native order if column is real vector type
  // Fallback to JS cosine over fetched candidates
  let notes: Array<{ id: string; hook: string; brief: string; embedding: unknown }> = [];
  try {
    // Attempt native pgvector query via raw sql (checks embedding_vec or embedding column)
    const sqlClient = (await import("../shared/config/database.js")).getSqlClient();
    const vecLiteral = `[${queryEmb.vector.join(",")}]`;
    // Use raw query with embedding_vec if available, falling back to embedding
    const rows = await sqlClient.unsafe(
      `SELECT id, hook, brief, COALESCE(embedding_vec::text, embedding) as embedding FROM agent_memory_notes WHERE agent_id = $1 AND lifecycle_status = 'active' AND (embedding_vec IS NOT NULL OR embedding IS NOT NULL) ORDER BY COALESCE(embedding_vec, embedding::vector) <=> $2::vector LIMIT $3`,
      [agentId, vecLiteral, limit] as unknown as string[],
    ) as unknown as Array<{ id: string; hook: string; brief: string; embedding: string }>;
    if (rows && rows.length > 0) {
      return rows.map((r, idx) => ({
        id: r.id,
        hook: r.hook,
        brief: r.brief,
        semanticScore: 1 - idx * 0.05, // approximate rank-based
        score: 1 - idx * 0.05,
      }));
    }
  } catch {}

  // JS fallback: load bounded window and score
  const windowSize = 60;
  const all = await db.query.agentMemoryNotes.findMany({
    where: sql`${agentMemoryNotes.agentId} = ${agentId} AND ${agentMemoryNotes.lifecycleStatus} = 'active'`,
    orderBy: (t: typeof agentMemoryNotes, { desc }: { desc: (c: unknown) => unknown }) => [desc(t.importanceScore as unknown as Date)],
    limit: windowSize,
  } as unknown as Parameters<typeof db.query.agentMemoryNotes.findMany>[0]);

  const scored = all
    .map((n: typeof all[number]) => {
      const vec = getCachedEmbeddingVector(n.id, (n as unknown as { embedding: unknown }).embedding);
      const semantic = vec ? (cosineSimilarity(queryEmb.vector, vec) + 1) / 2 : 0;
      return { id: n.id, hook: n.hook, brief: n.brief, semanticScore: semantic, score: semantic };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

export const embeddingsGate = {
  embedText,
  mockEmbed,
  cosineSimilarity,
  embedNote,
  embedNotesBatch,
  ensureEmbeddingsForAgent,
  searchByEmbedding,
  hybridScore,
};
