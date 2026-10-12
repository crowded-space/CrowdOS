import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { eq, desc, lt, and, sql } from "drizzle-orm";
import { getDb, isConnectionError, isDatabaseConfigured } from "../shared/config/database.js";
import { artifacts } from "../db/schema.js";
// Gate-only: the Workspace domain exposes the artifact-dir resolution ports, so
// Artifacts never reaches past its facade (Domain Facade Standard §2).
import {
  getWorkspaceRecord,
  resolveArtifactsDir,
  resolveRecordArtifactDir,
  resolveWorkspaceFolder,
  toFolderRelative,
} from "../workspace/workspace-gate.js";
import {
  localGetArtifact,
  localListArtifactsByRun,
  localListArtifactsByWorkspace,
  localUpsertArtifact,
} from "./artifact-local-store.js";
import type { CreateArtifactInput, ArtifactRow } from "./artifact-types.js";

// ─── Artifacts repository (canon: workspace artifactDir) ───────────────
// Generated artifacts are plain FILES under the workspace own artifactDir:
//
//   <workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext>
//
// The DB row keeps the FOLDER-RELATIVE path ("vfs/artifacts/<runId>/<file>"), so
// the record stays valid if the workspace folder moves, and the panel resolves
// it against whichever root it is showing. Generation never writes outside the
// workspace folder: artifactDir is normalized to a folder-relative path first.

/** Extension for an artifact body, derived from its type. */
function extensionFor(type: string, explicitPath?: string | null): string {
  if (explicitPath) {
    const match = /\.([A-Za-z0-9]+)$/.exec(explicitPath);
    if (match) return match[1].toLowerCase();
  }
  switch (type) {
    case "report":
    case "analysis_report":
      return "md";
    case "diff":
      return "patch";
    case "execution_log":
    case "reasoning_trace":
      return "jsonl";
    case "runtime_snapshot":
    case "citations":
      return "json";
    case "generated_component":
      return "ts";
    default:
      return "txt";
  }
}

/** Body worth persisting for a file-backed artifact, or null when there is none. */
function artifactBody(input: CreateArtifactInput): string | null {
  if (typeof input.contentRef === "string" && input.contentRef.length > 0) return input.contentRef;
  if (typeof input.patch === "string" && input.patch.length > 0) return input.patch;
  return null;
}

/**
 * Persist an artifact body to the workspace artifactDir. Best-effort: a
 * filesystem failure must not fail artifact creation, because the DB row is
 * still a valid pointer (the panel reports a missing file honestly).
 *
 * Returns the folder-relative path that was written, or null when there was no
 * body to write or the write failed.
 */
export async function writeArtifactFile(input: CreateArtifactInput, artifactId: string): Promise<string | null> {
  const body = artifactBody(input);
  if (body === null) return null;
  try {
    const folder = await resolveWorkspaceFolder(input.workspaceId);
    if (!folder) return null;
    const record = await getWorkspaceRecord(input.workspaceId).catch(() => null);
    const artifactDir = resolveRecordArtifactDir(record);
    const runSegment = input.runId ? String(input.runId) : "unscoped";
    const dir = join(resolveArtifactsDir(folder, artifactDir), runSegment);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, artifactId + "." + extensionFor(input.type, input.path));
    await fs.writeFile(file, body, "utf8");
    return toFolderRelative(file, folder);
  } catch {
    return null;
  }
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRow> {
  const id = "art_" + randomUUID().slice(0, 8) + "_" + Date.now().toString(36);
  const now = new Date();
  // Local-first (§17): the file body + local index ARE the commit, so
  // create_artifact works with no DATABASE_URL. The DB row is a best-effort
  // replica. Canon: generation defaults to the workspace artifactDir. An
  // explicit input.path is respected as the stored reference, but the body
  // still lands in the workspace own artifact folder (never in a user
  // repository).
  const written = await writeArtifactFile(input, id);
  const storedPath = written ?? input.path ?? null;
  const localRow: ArtifactRow = {
    id,
    workspaceId: input.workspaceId,
    producerAgent: input.producerAgent,
    artifactType: input.type,
    path: storedPath,
    semanticTags: input.semanticTags ?? [],
    metadata: written ? { ...(input.metadata ?? {}), artifactPath: written } : (input.metadata ?? {}),
    createdAt: now,
    runId: input.runId ?? null,
    beforeHash: input.beforeHash ?? null,
    afterHash: input.afterHash ?? null,
    patch: input.patch ?? null,
    contentRef: input.contentRef ?? null,
  };
  // Best-effort like the body write: a filesystem failure must not fail
  // artifact creation (the returned row stays a valid pointer).
  try {
    await localUpsertArtifact(localRow);
  } catch {}
  if (!isDatabaseConfigured()) {
    await emitArtifactEvents(input, id);
    return localRow;
  }
  try {
    const db = getDb();
    const [row] = await db.insert(artifacts).values({
      id,
      workspaceId: input.workspaceId,
      producerAgent: input.producerAgent,
      artifactType: input.type as any,
      path: storedPath,
      semanticTags: input.semanticTags ?? [],
      metadata: written ? { ...(input.metadata ?? {}), artifactPath: written } : (input.metadata ?? {}),
      createdAt: now,
      runId: input.runId ?? null,
      beforeHash: input.beforeHash ?? null,
      afterHash: input.afterHash ?? null,
      patch: input.patch ?? null,
      contentRef: input.contentRef ?? null,
    }).returning();
    const created = row as unknown as ArtifactRow;
    await emitArtifactEvents(input, id);
    return created;
  } catch (err) {
    // Configured-but-unreachable PG: the local commit already stands, so a
    // replica-leg failure must never surface as a caller-visible error.
    if (isConnectionError(err)) {
      await emitArtifactEvents(input, id);
      return localRow;
    }
    throw err;
  }
}

// SCL-3/ART-1: emit artifact events for observability and client sync (CTX-1 phantom handler fix)
// Explicit literal emits so check-events regex can detect them.
async function emitArtifactEvents(input: CreateArtifactInput, artifactId: string): Promise<void> {
  try {
    // Shared instance: a fresh EventBroker would reach no subscriber.
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = getSharedBroker();
    if (!broker) {
      console.warn("[artifacts] dropped artifact.created/updated: no shared broker registered");
    } else {
      const payload = { runId: input.runId ?? null, artifactId, artifactType: input.type, workspaceId: input.workspaceId } as never;
      const opts = { channelId: (input.metadata as Record<string, unknown> | undefined)?.channelId as string | undefined } as never;
      if (input.type === "diff") {
        broker.emit("diff.created", payload, opts);
      } else {
        broker.emit("artifact.created", payload, opts);
      }
      broker.emit("artifact.updated", payload, opts);
    }
  } catch {}
}

export async function getArtifactById(id: string): Promise<ArtifactRow | null> {
  if (!isDatabaseConfigured()) return localGetArtifact(id);
  try {
    const db = getDb();
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
    return (row as unknown as ArtifactRow) ?? null;
  } catch (err) {
    if (isConnectionError(err)) return localGetArtifact(id);
    throw err;
  }
}

export async function listArtifactsByRun(runId: string, opts?: { limit?: number; offset?: number }): Promise<ArtifactRow[]> {
  if (!isDatabaseConfigured()) return localListArtifactsByRun(runId, opts);
  try {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
    const offset = Math.min(10000, Math.max(0, opts?.offset ?? 0));
    // ponytail: explicit columns + truncate patch/contentRef blobs (full body via getArtifactById)
    const rows = await db.select({
      id: artifacts.id, workspaceId: artifacts.workspaceId, producerAgent: artifacts.producerAgent,
      artifactType: artifacts.artifactType, path: artifacts.path, semanticTags: artifacts.semanticTags,
      metadata: artifacts.metadata, createdAt: artifacts.createdAt, runId: artifacts.runId,
      beforeHash: artifacts.beforeHash, afterHash: artifacts.afterHash,
      patch: sql<string | null>`substring(${artifacts.patch} from 1 for 500)`,
      contentRef: sql<string | null>`substring(${artifacts.contentRef} from 1 for 500)`,
    }).from(artifacts).where(eq(artifacts.runId, runId)).orderBy(desc(artifacts.createdAt)).limit(limit).offset(offset);
    return rows as unknown as ArtifactRow[];
  } catch (err) {
    if (isConnectionError(err)) return localListArtifactsByRun(runId, opts);
    throw err;
  }
}

export async function listArtifactsByWorkspace(workspaceId: string, opts?: { limit?: number; offset?: number }): Promise<ArtifactRow[]> {
  if (!isDatabaseConfigured()) return localListArtifactsByWorkspace(workspaceId, opts);
  try {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
    const offset = Math.min(10000, Math.max(0, opts?.offset ?? 0));
    const rows = await db.select({
      id: artifacts.id, workspaceId: artifacts.workspaceId, producerAgent: artifacts.producerAgent,
      artifactType: artifacts.artifactType, path: artifacts.path, semanticTags: artifacts.semanticTags,
      metadata: artifacts.metadata, createdAt: artifacts.createdAt, runId: artifacts.runId,
      beforeHash: artifacts.beforeHash, afterHash: artifacts.afterHash,
      patch: sql<string | null>`substring(${artifacts.patch} from 1 for 500)`,
      contentRef: sql<string | null>`substring(${artifacts.contentRef} from 1 for 500)`,
    }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId)).orderBy(desc(artifacts.createdAt)).limit(limit).offset(offset);
    return rows as unknown as ArtifactRow[];
  } catch (err) {
    if (isConnectionError(err)) return localListArtifactsByWorkspace(workspaceId, opts);
    throw err;
  }
}

export async function purgeExpiredArtifacts(before: Date): Promise<number> {
  const db = getDb();
  const purged = await db.delete(artifacts).where(lt(artifacts.createdAt, before)).returning({ id: artifacts.id });
  return purged.length;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function runArtifactRetentionSweep(now: Date = new Date()): Promise<{ purged: number }> {
  const retentionDays = numEnv("RETENTION_DAYS", 30);
  if (retentionDays === 0) {
    const purged = await purgeExpiredArtifacts(now);
    return { purged };
  }
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const purged = await purgeExpiredArtifacts(cutoff);
  if (purged > 0) {
    console.log("[ArtifactRetention] Purged " + purged + " artifacts created before " + cutoff.toISOString() + " (retention " + retentionDays + "d). Workspace-cascade also applies.");
  }
  return { purged };
}
