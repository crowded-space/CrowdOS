// ─── Memory Local Store (degraded offline mirror, CrowdOS §18) ─────────
// File truth fallback for agent_memory_notes when PG is down or unconfigured.
//
// Canon (mock-structure-polished): the mirror lives inside the owning workspace:
//
//   <workspaceFolder>/vfs/.crowdos/memories/<agentId>.jsonl
//
// Writes mirror PG success (best-effort); reads serve degraded mode only.
// ponytail: O(n) scans, single-user local mode. No embeddings offline.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  resolveLocalStoreDir,
  searchableWorkspaceScopes,
  withStoreLock,
} from "../shared/core/local-file.js";

function safeAgent(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function fileFor(agentId: string, workspaceId?: string | null): string {
  return join(resolveLocalStoreDir(workspaceId), "memories", safeAgent(agentId) + ".jsonl");
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

async function readNoteFile(path: string): Promise<LocalMemoryNote[]> {
  try {
    const raw = await fs.readFile(path, "utf8");
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

/**
 * Upsert one note into the agent's local mirror (locked rewrite).
 *
 * Scope comes from the explicit argument, else the note's own workspaceId, else
 * the unscoped default folder — a note always lands in exactly one workspace.
 */
export async function mirrorMemoryNote(
  agentId: string,
  note: Record<string, unknown>,
  workspaceId?: string | null,
): Promise<void> {
  const row = toLocal(agentId, note);
  const scope = workspaceId ?? (note.workspaceId as string | null | undefined) ?? null;
  await withStoreLock("memories:" + (scope ?? "default") + ":" + safeAgent(agentId), async () => {
    const dir = join(resolveLocalStoreDir(scope), "memories");
    await fs.mkdir(dir, { recursive: true });
    const file = fileFor(agentId, scope);
    const rows = await readNoteFile(file);
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx === -1) rows.push(row);
    else rows[idx] = row;
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
  });
}

/**
 * Read this agent's local mirror. With a scope, one file. Without one, every
 * registered workspace is merged (an agent id is the only key the caller has).
 */
export async function readLocalMemoryNotes(
  agentId: string,
  workspaceId?: string | null,
): Promise<LocalMemoryNote[]> {
  const scopes: Array<string | null> = workspaceId && workspaceId.trim()
    ? [workspaceId]
    : searchableWorkspaceScopes();
  const byId = new Map<string, LocalMemoryNote>();
  for (const scope of scopes) {
    const rows = await readNoteFile(fileFor(agentId, scope)).catch(() => [] as LocalMemoryNote[]);
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Naive degraded search: substring score over hook/brief/body (no vectors). */
export function scoreLocalNote(note: LocalMemoryNote, query: string): number {
  const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (q.length === 0) return note.importanceScore * 0.5;
  const hay = note.hook + " " + note.brief + " " + note.observed + " " + note.detailed;
  const lower = hay.toLowerCase();
  let hits = 0;
  for (const t of q) if (lower.includes(t)) hits++;
  return (hits / q.length) * 0.7 + note.importanceScore * 0.3;
}
