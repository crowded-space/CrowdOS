// ─── Artifact Local Store (C3 local-first, §17) ────────────────────────
// File truth for artifacts when PG is not the tier. Bodies already live as
// plain files under <workspaceFolder>/vfs/artifacts/<run>/<id>.<ext>; this
// index carries the row metadata so create/get/list work with no DATABASE_URL:
//
//   <workspaceFolder>/vfs/.crowdos/artifacts.json
//
// Local-first: the body write + this index commit ARE the durable write; the
// DB insert in artifacts-repository.ts is a best-effort replica. Reads serve
// this index whenever the DB leg is unconfigured or unreachable.
// ponytail: O(n) scans per read + full bodies in the index; single-user local
// mode only (PG carries multi-process/production).

import {
  candidateWorkspaceScopes,
  mutateJsonArray,
  readJsonArray,
} from "../shared/core/local-file.js";
import type { ArtifactRow, ArtifactType } from "./artifact-types.js";

const INDEX_FILE = "artifacts.json";

/** DB parity: listings cap patch/contentRef at 500 chars; getById serves full bodies. */
const LIST_BODY_CAP = 500;

interface LocalArtifactRow {
  id: string;
  workspaceId: string;
  producerAgent: string;
  artifactType: ArtifactType;
  path: string | null;
  semanticTags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  runId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string | null;
  contentRef: string | null;
}

function serialize(row: ArtifactRow): LocalArtifactRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    producerAgent: row.producerAgent,
    artifactType: row.artifactType,
    path: row.path,
    semanticTags: row.semanticTags,
    metadata: row.metadata,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    runId: row.runId,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    patch: row.patch,
    contentRef: row.contentRef,
  };
}

function revive(row: LocalArtifactRow): ArtifactRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
  };
}

function truncateForList(row: ArtifactRow): ArtifactRow {
  const cap = (v: string | null): string | null =>
    typeof v === "string" && v.length > LIST_BODY_CAP ? v.slice(0, LIST_BODY_CAP) : v;
  return { ...row, patch: cap(row.patch), contentRef: cap(row.contentRef) };
}

/** Upsert by id into the workspace index. */
export async function localUpsertArtifact(row: ArtifactRow): Promise<ArtifactRow> {
  const stored = serialize(row);
  await mutateJsonArray<LocalArtifactRow>(
    INDEX_FILE,
    (rows) => {
      const idx = rows.findIndex((r) => r.id === stored.id);
      if (idx === -1) rows.push(stored);
      else rows[idx] = stored;
    },
    row.workspaceId,
  );
  return revive(stored);
}

/**
 * Fetch one row with full blobs. A named workspace reads its own index only;
 * an unscoped lookup (legacy callers carrying just the id) locates the owner
 * folder across candidate scopes.
 */
export async function localGetArtifact(
  id: string,
  workspaceId?: string | null,
): Promise<ArtifactRow | null> {
  const scopes = workspaceId ? [workspaceId] : candidateWorkspaceScopes();
  for (const scope of scopes) {
    const rows = await readJsonArray<LocalArtifactRow>(INDEX_FILE, scope);
    const found = rows.find((r) => r.id === id);
    if (found) return revive(found);
  }
  return null;
}

async function localScan(opts: {
  workspaceId?: string | null;
  runId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ArtifactRow[]> {
  const scopes = opts.workspaceId ? [opts.workspaceId] : candidateWorkspaceScopes();
  const all: ArtifactRow[] = [];
  for (const scope of scopes) {
    const rows = await readJsonArray<LocalArtifactRow>(INDEX_FILE, scope);
    for (const r of rows) {
      if (opts.workspaceId && r.workspaceId !== opts.workspaceId) continue;
      if (opts.runId !== undefined && opts.runId !== null && r.runId !== opts.runId) continue;
      all.push(revive(r));
    }
  }
  all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : -1));
  const limit = Math.min(200, Math.max(1, opts.limit ?? 200));
  const offset = Math.min(10000, Math.max(0, opts.offset ?? 0));
  return all.slice(offset, offset + limit).map(truncateForList);
}

/** Truncated listing by run (runId→workspace is unknown locally, so scopes fan out). */
export async function localListArtifactsByRun(
  runId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ArtifactRow[]> {
  return localScan({ runId, limit: opts?.limit, offset: opts?.offset });
}

/** Truncated listing inside one workspace index. */
export async function localListArtifactsByWorkspace(
  workspaceId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ArtifactRow[]> {
  return localScan({ workspaceId, limit: opts?.limit, offset: opts?.offset });
}
