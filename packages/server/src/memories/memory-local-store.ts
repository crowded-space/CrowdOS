// ─── Memory Local Store (degraded offline mirror, CrowdOS §18) ─────────
// File truth fallback for agent_memory_notes when PG is down or unconfigured.
// Layout: <localstore>/memories/<agentId>.jsonl (one full note per line).
// Writes mirror PG success (best-effort); reads serve degraded mode only.
// ponytail: O(n) scans, single-user local mode. No embeddings offline.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveLocalStoreDir, withStoreLock } from "../shared/core/local-file.js";

function safeAgent(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function fileFor(agentId: string): string {
  return join(resolveLocalStoreDir(), "memories", `${safeAgent(agentId)}.jsonl`);
}

export interface LocalMemoryNote {
  id: string;
  agentId: string;
  channelId: string | null;
  noteType: string;
  noteTimestamp: string;
  importanceScore: number;
  confidence: string;
  sourceType: string;
  emotionalValence: string;
  accessCount: number;
  lastAccessed: string | null;
  links: string[];
  contradictionFlags: string[];
  lifecycleStatus: string;
  hook: string;
  brief: string;
  observed: string;
  interpreted: string;
  feltSense: string;
  futureRelevance: string;
  uncertainty: string;
  detailed: string;
  createdAt: string;
  updatedAt: string;
}

function toLocal(agentId: string, note: Record<string, unknown>): LocalMemoryNote {
  const g = (k: string, fb: unknown = null) => (note[k] ?? fb) as never;
  const iso = (v: unknown): string => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string" && v) return v;
    return new Date().toISOString();
  };
  return {
    id: String(g("id")),
    agentId,
    channelId: (g("channelId", null) as string | null) ?? null,
    noteType: String(g("noteType", "episodic")),
    noteTimestamp: iso(g("noteTimestamp")),
    importanceScore: Number(g("importanceScore", 0.5)),
    confidence: String(g("confidence", "medium")),
    sourceType: String(g("sourceType", "direct_experience")),
    emotionalValence: String(g("emotionalValence", "neutral")),
    accessCount: Number(g("accessCount", 0)),
    lastAccessed: g("lastAccessed", null) ? iso(g("lastAccessed")) : null,
    links: (g("links", []) as string[]) ?? [],
    contradictionFlags: (g("contradictionFlags", []) as string[]) ?? [],
    lifecycleStatus: String(g("lifecycleStatus", "active")),
    hook: String(g("hook", "")),
    brief: String(g("brief", "")),
    observed: String(g("observed", "")),
    interpreted: String(g("interpreted", "")),
    feltSense: String(g("feltSense", "")),
    futureRelevance: String(g("futureRelevance", "")),
    uncertainty: String(g("uncertainty", "")),
    detailed: String(g("detailed", "")),
    createdAt: iso(g("createdAt")),
    updatedAt: iso(g("updatedAt")),
  };
}

/** Upsert one note into the agent's local mirror (locked rewrite). */
export async function mirrorMemoryNote(agentId: string, note: Record<string, unknown>): Promise<void> {
  const row = toLocal(agentId, note);
  await withStoreLock(`memories:${safeAgent(agentId)}`, async () => {
    const dir = join(resolveLocalStoreDir(), "memories");
    await fs.mkdir(dir, { recursive: true });
    let rows: LocalMemoryNote[] = [];
    try {
      const raw = await fs.readFile(fileFor(agentId), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as LocalMemoryNote);
        } catch {
          // skip torn line
        }
      }
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== "ENOENT") throw err;
    }
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx === -1) rows.push(row);
    else rows[idx] = row;
    await fs.writeFile(fileFor(agentId), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
  });
}

/** Read this agent's local mirror (missing file reads as []). */
export async function readLocalMemoryNotes(agentId: string): Promise<LocalMemoryNote[]> {
  try {
    const raw = await fs.readFile(fileFor(agentId), "utf8");
    const rows: LocalMemoryNote[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LocalMemoryNote);
      } catch {
        // skip torn line
      }
    }
    return rows;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    throw err;
  }
}

/** Naive degraded search: substring score over hook/brief/body (no vectors). */
export function scoreLocalNote(note: LocalMemoryNote, query: string): number {
  const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (q.length === 0) return note.importanceScore * 0.5;
  const hay = `${note.hook} ${note.brief} ${note.observed} ${note.detailed}`.toLowerCase();
  let hits = 0;
  for (const t of q) if (hay.includes(t)) hits++;
  return (hits / q.length) * 0.7 + note.importanceScore * 0.3;
}
