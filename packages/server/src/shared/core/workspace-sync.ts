// ─── Workspace DB↔Local Sync (local-wins write-through) ───────────────
// Cross-domain orchestration: PG tier via tenant handles, file tier via the
// domain local stores. Steady-state rule — local files are truth
// (CrowdOS §17); PG is a best-effort write-through replica, never an
// equal master. Push = local→PG upserts. Converge = local-wins push
// (no PG→local union, no resequence). Pull is explicit only (import /
// flush-local), never automatic.
// Pairing rule (workspace-ID anchored, evaluated at DB-attach):
//   DB has no workspace rows + local empty → pair (fresh-fresh)
//   DB has no workspace rows + local content → push local up, pair
//   DB has this id + local empty → import into localstore, pair
//   DB has this id + local content → converge (union-merge), pair
//   DB non-empty + zero overlap with registry ids → CONFLICT (quarantine:
//   keep serving local, refuse DB R/W until the user resolves)
// The side with an empty workspace id pulls from the side that has one.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import { isConnectionError, noteDbFailure, resolveTier } from "../config/database.js";
import {
  closeWorkspaceDatabase,
  getWorkspaceDb,
  getWorkspaceRecord,
  listWorkspaceRecords,
  saveWorkspaceRecord,
  tierContextFor,
  type DbSyncState,
} from "../../workspace/workspace-gate.js";
import { agentGate, type LocalAgentRow } from "../../agents/agent-gate.js";
import { globalBroker } from "../sockets/register-socket-server.js";
import { LibrarianRuntime } from "./librarian-runtime.js";
import { agents, categories, channelSequences, channelSettings, channels, messages, workspaces } from "../../db/schema.js";
import {
  mutateJsonArray,
  mutateJsonObject,
  readJsonArray,
  readJsonl,
  resolveLocalStoreDir,
  writeJsonFile,
  deleteFile,
} from "./local-file.js";
import { resolveWorkspaceAgentsDir } from "./local-file.js";
import { readOutbox, removeOutboxIds, type OutboxEntry } from "./outbox.js";
import type { LocalChannelRow, LocalChannelSettingsRow, LocalCategoryRow } from "../../channels/channel-local-store.js";
import type { LocalMessageRow } from "../../messages/message-local-store.js";

export interface PairingResult {
  action: "paired" | "import" | "push" | "converge" | "conflict" | "unreachable" | "no-database";
  dbWorkspaceId: string | null;
  detail?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function setSyncState(workspaceId: string, dbWorkspaceId: string | null, state: DbSyncState): Promise<void> {
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  if (!record) return;
  record.dbSync = { dbWorkspaceId, state, updatedAt: nowIso() };
  await saveWorkspaceRecord(record).catch(() => {});
}

/** Local content probe: channels/agents/messages presence for pairing decisions. */
export async function localWorkspaceContent(workspaceId: string): Promise<{
  empty: boolean;
  channels: number;
  agents: number;
  messages: number;
}> {
  const [chans, ags] = await Promise.all([
    readJsonArray<LocalChannelRow>("channels.json", workspaceId).catch(() => []),
    agentGate.listLocalAgentRows(workspaceId).catch(() => []),
  ]);
  const ownChannels = chans.filter((c) => (c.workspaceId ?? "default") === workspaceId);
  // Isolation: scoped roster per workspace; legacy null rows belong to default.
  const ownAgents = ags.filter((a) => !a.isTemplate && ((a.workspaceId ?? "default") === workspaceId));
  let messageCount = 0;
  for (const ch of ownChannels) {
    try {
      const rows = await readJsonl(ch.id, workspaceId);
      messageCount += rows.length;
      if (messageCount > 0) break;
    } catch {
      // unreadable channel log counts as empty
    }
  }
  return {
    empty: ownChannels.length === 0 && messageCount === 0 && ownAgents.filter((a) => a.name !== "default-assistant").length === 0,
    channels: ownChannels.length,
    agents: ownAgents.length,
    messages: messageCount,
  };
}

function reviveDates<T extends Record<string, any>>(row: T, fields: string[]): T {
  const next = { ...row };
  for (const f of fields) {
    const v = (next as any)[f];
    if (typeof v === "string" && v) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) (next as any)[f] = d;
    }
  }
  return next;
}

// ─── Pairing evaluation (runs at DB-attach) ────────────────────────────

export async function evaluateDbPairing(workspaceId: string): Promise<PairingResult> {
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  const recordUrl = record?.databaseUrl?.trim() || null;
  if (!recordUrl) return { action: "no-database", dbWorkspaceId: null };

  let db: Awaited<ReturnType<typeof getWorkspaceDb>>["db"];
  try {
    ({ db } = await getWorkspaceDb(workspaceId));
  } catch (err) {
    return { action: "unreachable", dbWorkspaceId: null, detail: err instanceof Error ? err.message : String(err) };
  }

  let dbIds: string[];
  try {
    const rows = await (db as any).query.workspaces.findMany({ columns: { id: true } });
    dbIds = rows.map((r: any) => r.id);
  } catch (err) {
    if (isConnectionError(err)) return { action: "unreachable", dbWorkspaceId: null };
    throw err;
  }

  const local = await localWorkspaceContent(workspaceId);
  const dbHasSelf = dbIds.includes(workspaceId);

  if (dbIds.length === 0 && local.empty) {
    await setSyncState(workspaceId, workspaceId, "paired");
    return { action: "paired", dbWorkspaceId: workspaceId, detail: "fresh database, empty local store" };
  }
  if (dbIds.length === 0 && !local.empty) {
    await setSyncState(workspaceId, workspaceId, "pushing");
    await pushWorkspaceToDb(workspaceId, { pruneExtras: false });
    await setSyncState(workspaceId, workspaceId, "paired");
    return { action: "push", dbWorkspaceId: workspaceId, detail: "uploaded local state to fresh database" };
  }
  if (dbHasSelf && local.empty) {
    await setSyncState(workspaceId, workspaceId, "importing");
    await pullWorkspaceFromDb(workspaceId, { force: true });
    await setSyncState(workspaceId, workspaceId, "paired");
    return { action: "import", dbWorkspaceId: workspaceId, detail: "imported database rows into empty local store" };
  }
  if (dbHasSelf && !local.empty) {
    await convergeWorkspace(workspaceId);
    await setSyncState(workspaceId, workspaceId, "paired");
    return { action: "converge", dbWorkspaceId: workspaceId, detail: "union-merged both tiers" };
  }
  // DB non-empty but no overlap with any local registry id → wrong database.
  const localIds = new Set((await listWorkspaceRecords().catch(() => [])).map((r) => r.id));
  const overlap = dbIds.some((id) => localIds.has(id));
  if (!overlap) {
    await setSyncState(workspaceId, dbIds[0] ?? null, "conflict");
    return {
      action: "conflict",
      dbWorkspaceId: dbIds[0] ?? null,
      detail: "database holds unrelated workspaces; serving local only until resolved",
    };
  }
  // Shared DB already paired with siblings; this workspace is new to it.
  if (local.empty) {
    await setSyncState(workspaceId, workspaceId, "paired");
    return { action: "paired", dbWorkspaceId: workspaceId, detail: "joined shared database" };
  }
  await pushWorkspaceToDb(workspaceId, { pruneExtras: false });
  await setSyncState(workspaceId, workspaceId, "paired");
  return { action: "push", dbWorkspaceId: workspaceId, detail: "uploaded local state to shared database" };
}

// ─── Push (local → DB) ─────────────────────────────────────────────────

async function tenantDb(workspaceId: string): Promise<any> {
  const { db } = await getWorkspaceDb(workspaceId);
  return db;
}

function withoutId<T extends Record<string, any>>(row: T): Omit<T, "id"> {
  const next = { ...row };
  delete (next as any).id;
  return next;
}

/** Keep the PG sequence counter at/above the pushed max so appends never reuse seqs. */
async function repairPgCounter(db: any, channelId: string, maxSeq: number): Promise<void> {
  if (maxSeq <= 0) return;
  await db.insert(channelSequences).values({ channelId, lastSeq: maxSeq, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: channelSequences.channelId,
      set: {
        lastSeq: sql`GREATEST(${channelSequences.lastSeq}, ${maxSeq})`,
        updatedAt: new Date(),
      },
    });
}

export async function pushWorkspaceToDb(workspaceId: string, opts: { pruneExtras?: boolean } = {}): Promise<{
  categories: number;
  channels: number;
  settings: number;
  agents: number;
  messages: number;
}> {
  const db = await tenantDb(workspaceId);
  const counts = { categories: 0, channels: 0, settings: 0, agents: 0, messages: 0 };

  const allCats = (await readJsonArray<LocalCategoryRow>("categories.json", workspaceId).catch(() => []))
    .filter((c) => (c.workspaceId ?? "default") === workspaceId);
  for (const c of allCats) {
    const row = reviveDates({ ...c }, ["createdAt"]);
    // Canon virtual mounts ride the row; rows without one simply write NULL.
    await (db as any).insert(categories).values(row).onConflictDoUpdate({
      target: categories.id,
      set: withoutId(row),
    });
    counts.categories++;
  }

  // Isolation: push only this workspace's roster slice (scoped + legacy
  // null rows owned by default). Never push the whole global file.
  const allAgents = (await agentGate.listLocalAgentRows(workspaceId).catch(() => []))
    .filter((a) => !a.isTemplate && ((a.workspaceId ?? "default") === workspaceId));
  for (const a of allAgents) {
    const row = reviveDates({ ...a }, ["createdAt", "updatedAt", "archivedAt"]);
    await (db as any).insert(agents).values(row).onConflictDoUpdate({
      target: agents.id,
      set: withoutId(row),
    });
    counts.agents++;
  }
  // AGT-007: synced rows bypass service mutations; invalidate the roster so
  // the next list() is fresh.
  if (counts.agents > 0) {
    try {
      const { agentGate } = await import("../../agents/agent-gate.js");
      (agentGate as unknown as { invalidateRosterCache?: () => void }).invalidateRosterCache?.();
    } catch {}
  }

  const allChannels = (await readJsonArray<LocalChannelRow>("channels.json", workspaceId).catch(() => []))
    .filter((c) => (c.workspaceId ?? "default") === workspaceId);
  for (const c of allChannels) {
    const row = reviveDates({ ...c }, ["createdAt", "archivedAt"]);
    // Canon virtual mounts ride the row; rows without one simply write NULL.
    await (db as any).insert(channels).values(row).onConflictDoUpdate({
      target: channels.id,
      set: withoutId(row),
    });
    counts.channels++;
  }

  // CHN-009: settings pins are their own entity now (outbox replay + push).
  // Push only rows whose channel is in this workspace's pushed set — an
  // orphan pin would violate the channel_id FK and abort the whole push.
  const channelIds = new Set(allChannels.map((c) => c.id));
  const allSettings = (await readJsonArray<LocalChannelSettingsRow>("channel-settings.json", workspaceId).catch(() => []))
    .filter((s) => (s.workspaceId ?? "default") === workspaceId && channelIds.has(s.channelId));
  for (const s of allSettings) {
    const row = reviveDates({ ...s }, ["updatedAt"]);
    // Column-split ownership: only the pin columns are pushed; fs_policy /
    // safety_settings stay with the safety routes.
    await (db as any)
      .insert(channelSettings)
      .values(row)
      .onConflictDoUpdate({
        target: [channelSettings.channelId, channelSettings.workspaceId],
        set: withoutId(row),
      });
    counts.settings++;
  }

  for (const c of allChannels) {
    const localRows = (await readJsonl(c.id, workspaceId).catch(() => [])) as unknown as LocalMessageRow[];
    if (opts.pruneExtras) {
      await (db as any).delete(messages).where(eq(messages.channelId, c.id));
    }
    let maxSeq = 0;
    for (const m of localRows) {
      const row = reviveDates({ ...m }, ["timestamp"]);
      await (db as any).insert(messages).values(row).onConflictDoNothing({
        target: [messages.channelId, messages.sequenceNumber],
      });
      maxSeq = Math.max(maxSeq, Number(m.sequenceNumber) || 0);
      counts.messages++;
    }
    await repairPgCounter(db, c.id, maxSeq);
  }
  return counts;
}

// ─── Pull (DB → local, import + flush-local) ───────────────────────────

export async function pullWorkspaceFromDb(workspaceId: string, opts: { force?: boolean } = {}): Promise<{
  categories: number;
  channels: number;
  settings: number;
  agents: number;
  messages: number;
}> {
  if (!opts.force) {
    const local = await localWorkspaceContent(workspaceId);
    if (!local.empty) throw new Error("Local workspace is not empty; use force to overwrite (flush-local).");
  }
  const db = await tenantDb(workspaceId);
  const counts = { categories: 0, channels: 0, settings: 0, agents: 0, messages: 0 };

  const dbCats = await (db as any).query.categories.findMany({
    where: eq(categories.workspaceId, workspaceId),
  }).catch(() => []);
  await mutateJsonArray<LocalCategoryRow>("categories.json", (rows) => {
    const rest = rows.filter((r) => (r.workspaceId ?? "default") !== workspaceId);
    const pulled: LocalCategoryRow[] = dbCats.map((c: any) => ({
      id: c.id, name: c.name, workspaceId: c.workspaceId ?? workspaceId,
      folderPath: c.folderPath ?? null, ownedByAgentId: c.ownedByAgentId ?? null,
      embeddingProfileId: c.embeddingProfileId ?? null,
      // Canon virtual mounts ride the row; PG rows may predate the column.
      fsMounts: c.fsMounts ?? undefined,
      createdBy: c.createdBy,
      position: c.position ?? 0, createdAt: new Date(c.createdAt).toISOString(),
    }));
    counts.categories = pulled.length;
    return [...rest, ...pulled];
  }, workspaceId);

  // Isolation: pull only this workspace's slice + legacy-global rows.
  const dbAgents = (await (db as any).query.agents.findMany({}).catch(() => []))
    .filter((a: any) => (a.workspaceId ?? null) === null || a.workspaceId === workspaceId);
  // Canon: the roster is one file per agent under vfs/agents, so a pull writes
  // each missing agent individually rather than rewriting one shared array.
  {
    const existing = await agentGate.listLocalAgentRows(workspaceId).catch(() => [] as LocalAgentRow[]);
    const byId = new Map(existing.map((r) => [r.id, r]));
    for (const a of dbAgents) {
      if (byId.has(a.id)) continue;
      const row: LocalAgentRow = {
        id: a.id, workspaceId: a.workspaceId ?? null,
        name: a.name, title: a.title, species: a.species ?? undefined,
        avatar: a.avatar ?? undefined, authorityLevel: a.authorityLevel,
        l3Subtype: a.l3Subtype ?? undefined, modelModuleId: a.modelModuleId ?? null,
        instructionModuleId: a.instructionModuleId, toolkitModuleId: a.toolkitModuleId ?? undefined,
        constraintsModuleId: a.constraintsModuleId ?? undefined,
        capabilitiesModuleId: a.capabilitiesModuleId ?? undefined,
        memorySharingPolicy: a.memorySharingPolicy ?? "full", isOmniscient: !!a.isOmniscient,
        fallbackAgentId: a.fallbackAgentId ?? undefined, categoryPermissions: a.categoryPermissions ?? [],
        permissions: a.permissions ?? { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
        status: a.status ?? "offline", isTemplate: !!a.isTemplate,
        archivedAt: a.archivedAt ? new Date(a.archivedAt).toISOString() : null,
        archivedReason: a.archivedReason ?? null,
        contextTokenCap: (a as any).contextTokenCap ?? null,
        createdAt: new Date(a.createdAt).toISOString(), updatedAt: new Date(a.updatedAt).toISOString(),
      };
      const file = join(resolveWorkspaceAgentsDir(workspaceId), row.id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
      await writeJsonFile(file, row);
      byId.set(row.id, row);
      counts.agents++;
    }
  }

  const dbChannels = await (db as any).query.channels.findMany({
    where: eq(channels.workspaceId, workspaceId),
  }).catch(() => []);
  await mutateJsonArray<LocalChannelRow>("channels.json", (rows) => {
    const rest = rows.filter((r) => (r.workspaceId ?? "default") !== workspaceId);
    const pulled: LocalChannelRow[] = dbChannels.map((c: any) => ({
      id: c.id, categoryId: c.categoryId ?? null, workspaceId: c.workspaceId ?? workspaceId,
      folderPath: c.folderPath ?? null, name: c.name, type: c.type ?? "standard",
      // Canon virtual mounts ride the row; PG rows may predate the column.
      fsMounts: c.fsMounts ?? undefined,
      createdBy: c.createdBy, position: c.position ?? 0,
      createdAt: new Date(c.createdAt).toISOString(),
      archivedAt: c.archivedAt ? new Date(c.archivedAt).toISOString() : null,
      archivedReason: c.archivedReason ?? null,
    }));
    counts.channels = pulled.length;
    return [...rest, ...pulled];
  }, workspaceId);

  // CHN-009: pull settings pins for this workspace's channels too, so a
  // flush-local / import round-trip keeps the pins (was: local-only pins
  // survived a flush but PG-side pins never came back).
  const pulledChannelIds = new Set(dbChannels.map((c: any) => c.id));
  const dbSettings = (await (db as any).query.channelSettings.findMany({
    where: eq(channelSettings.workspaceId, workspaceId),
  }).catch(() => []))
    .filter((s: any) => pulledChannelIds.has(s.channelId));
  await mutateJsonArray<LocalChannelSettingsRow>("channel-settings.json", (rows) => {
    const rest = rows.filter((r) => (r.workspaceId ?? "default") !== workspaceId);
    const pulled: LocalChannelSettingsRow[] = dbSettings.map((s: any) => ({
      channelId: s.channelId,
      workspaceId: s.workspaceId ?? workspaceId,
      pinnedRuntime: s.pinnedRuntime ?? null,
      activeAgentId: s.activeAgentId ?? null,
      defaultAgentId: s.defaultAgentId ?? null,
      updatedAt: new Date(s.updatedAt).toISOString(),
    }));
    counts.settings = pulled.length;
    return [...rest, ...pulled];
  }, workspaceId);

  for (const c of dbChannels) {
    const pgRows = await (db as any).query.messages.findMany({
      where: eq(messages.channelId, c.id),
      orderBy: (t: any, { asc }: any) => [asc(t.sequenceNumber)],
    }).catch(() => []);
    const dir = join(resolveLocalStoreDir(workspaceId), "messages");
    await fs.mkdir(dir, { recursive: true });
    const lines = pgRows.map((m: any) =>
      JSON.stringify({
        ...m,
        timestamp: new Date(m.timestamp).toISOString(),
        mentions: m.mentions ?? [],
      }),
    );
    await fs.writeFile(join(dir, `${String(c.id).replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`), lines.length > 0 ? lines.join("\n") + "\n" : "");
    counts.messages += lines.length;
    // Repair the local counter so future appends continue past the import.
    const maxSeq = pgRows.reduce((n: number, m: any) => Math.max(n, Number(m.sequenceNumber) || 0), 0);
    if (maxSeq > 0) {
      await mutateJsonObject<number>("sequences.json", (obj) => {
        const key = `ch:${c.id}`;
        obj[key] = Math.max(typeof obj[key] === "number" ? (obj[key] as number) : 0, maxSeq);
      }, workspaceId);
    }
  }
  return counts;
}

// ─── Converge (local-wins write-through) ─────────────────────────────────
// Local files are truth (CrowdOS §17); PG is a replica. Converge = push the
// local tier up (upsert-by-id, no deletes, no resequence). PG-only rows are
// left untouched — pull/import is the explicit way back. Bulk push supersedes
// the outbox queue for this workspace.

export async function convergeWorkspace(workspaceId: string): Promise<{
  categories: number;
  channels: number;
  settings: number;
  agents: number;
  messages: number;
}> {
  const counts = await pushWorkspaceToDb(workspaceId, { pruneExtras: false });
  // Bulk ops supersede the queue for this workspace.
  await clearWorkspaceOutbox(workspaceId);
  return counts;
}

// ─── Outbox drain (backfill to DB) ─────────────────────────────────────

async function replayEntry(db: any, entry: OutboxEntry): Promise<void> {
  const row = entry.row ? reviveDates({ ...entry.row }, ["createdAt", "updatedAt", "archivedAt", "timestamp"]) : null;
  // Partial rows (e.g., status-only flips) merge over the existing PG row so
  // replay never nulls columns it doesn't carry.
  const readers = {
    category: () => db.query.categories.findFirst({ where: eq(categories.id, entry.rowId) }),
    channel: () => db.query.channels.findFirst({ where: eq(channels.id, entry.rowId) }),
    agent: () => db.query.agents.findFirst({ where: eq(agents.id, entry.rowId) }),
  } as const;
  const mergeOver = async (kind: keyof typeof readers) => {
    if (!row) return row;
    const existing = await readers[kind]().catch(() => null);
    return existing ? { ...existing, ...row, id: entry.rowId } : row;
  };
  switch (entry.entity) {
    case "category": {
      if (entry.op === "delete") {
        await db.delete(categories).where(eq(categories.id, entry.rowId));
        return;
      }
      const full = await mergeOver('category');
      await db.insert(categories).values(full).onConflictDoUpdate({ target: categories.id, set: withoutId(full) });
      return;
    }
    case "channel": {
      if (entry.op === "delete") {
        await db.delete(channels).where(eq(channels.id, entry.rowId));
        return;
      }
      const full = await mergeOver('channel');
      await db.insert(channels).values(full).onConflictDoUpdate({ target: channels.id, set: withoutId(full) });
      return;
    }
    case "agent": {
      if (entry.op === "delete") {
        await db.delete(agents).where(eq(agents.id, entry.rowId));
        try {
          const { agentGate } = await import("../../agents/agent-gate.js");
          (agentGate as unknown as { invalidateRosterCache?: () => void }).invalidateRosterCache?.();
        } catch {}
        return;
      }
      const full = await mergeOver('agent');
      await db.insert(agents).values(full).onConflictDoUpdate({ target: agents.id, set: withoutId(full) });
      try {
        const { agentGate } = await import("../../agents/agent-gate.js");
        (agentGate as unknown as { invalidateRosterCache?: () => void }).invalidateRosterCache?.();
      } catch {}
      return;
    }
    case "message": {
      if (entry.op === "delete") return; // messages are immutable; tombstones are no-ops
      // Insert-ignore by id (PK): seq collisions across tiers must not drop rows.
      await db.insert(messages).values(row).onConflictDoNothing({ target: messages.id });
      // MSG-020: repair the PG counter upward as part of the replay (same
      // GREATEST upsert as repairPgCounter and the append replica leg). The
      // failed replica leg may have been the only writer of channel_sequences
      // for this seq, so a later PG-side allocateSequence would reissue it and
      // the reissued row would be silently dropped by the targeted
      // onConflictDoNothing.
      const replaySeq = Number((row as any)?.sequenceNumber);
      const replayChannelId = (row as any)?.channelId;
      if (typeof replayChannelId === "string" && Number.isFinite(replaySeq)) {
        await repairPgCounter(db, replayChannelId, replaySeq);
      }
      return;
    }
    case "channelSettings": {
      // CHN-009: settings pins replay into the (channel_id, workspace_id)
      // composite-PK row. Upsert only the pin columns — fs_policy /
      // safety_settings stay with the safety routes (column-split ownership),
      // so a replay never clobbers them.
      if (entry.op === "delete") return; // pins are upsert-only; no tombstone exists
      const pinRow = (row ?? {}) as Record<string, unknown>;
      // Partial rows (single-pin patches) merge over the existing PG row so
      // replay never nulls a pin it does not carry.
      const set: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ["pinnedRuntime", "activeAgentId", "defaultAgentId"] as const) {
        if (key in pinRow) set[key] = pinRow[key] ?? null;
      }
      await db
        .insert(channelSettings)
        .values({
          channelId: entry.rowId,
          workspaceId: (pinRow.workspaceId ?? entry.workspaceId ?? "default") as string,
          ...set,
        })
        .onConflictDoUpdate({ target: [channelSettings.channelId, channelSettings.workspaceId], set });
      return;
    }
  }
}

export async function drainOutbox(workspaceId?: string | null): Promise<{
  replayed: number;
  skipped: number;
  pending: number;
}> {
  const entries = await readOutbox(2000);
  const acked = new Set<string>();
  let replayed = 0;
  let skipped = 0;
  const handles = new Map<string, any>();
  for (const entry of entries) {
    if (workspaceId && entry.workspaceId !== workspaceId) {
      skipped++;
      continue;
    }
    const wsId = entry.workspaceId;
    try {
      const ctx = await tierContextFor(wsId);
      // Only drain when the workspace would dual-write now (reachable + not forced-local).
      if (resolveTier(ctx).tier !== "dual") {
        skipped++;
        continue;
      }
      // Quarantined workspaces (pairing conflict) refuse DB traffic entirely.
      if (wsId) {
        const rec = await getWorkspaceRecord(wsId).catch(() => null);
        if (rec?.dbSync?.state === "conflict") {
          skipped++;
          continue;
        }
      }
      let handle = wsId ? handles.get(wsId) : null;
      if (!handle && wsId) {
        handle = (await getWorkspaceDb(wsId)).db;
        handles.set(wsId, handle);
      }
      if (!handle) {
        skipped++;
        continue;
      }
      await replayEntry(handle, entry);
      acked.add(entry.id);
      replayed++;
    } catch (err) {
      if (isConnectionError(err)) {
        noteDbFailure(null, err);
        skipped++;
        continue;
      }
      // Logic error on replay (e.g., FK drift): drop the poison entry so the
      // queue keeps moving, and surface it in logs.
      console.error(`[Outbox] Dropping unreplayable entry ${entry.id} (${entry.entity}:${entry.op}):`, err instanceof Error ? err.message : err);
      acked.add(entry.id);
    }
  }
  await removeOutboxIds(acked);
  const pending = (await readOutbox(1_000_000)).length;
  return { replayed, skipped, pending };
}

/** Drop queued entries for a workspace (bulk ops supersede the queue). */
export async function clearWorkspaceOutbox(workspaceId: string): Promise<void> {
  const entries = await readOutbox(100_000);
  await removeOutboxIds(entries.filter((e) => e.workspaceId === workspaceId).map((e) => e.id));
}

/** Pending backlog count for a workspace (Overview yellow notice). */
export async function outboxBacklog(workspaceId: string): Promise<number> {
  const entries = await readOutbox(100_000);
  return entries.filter((e) => e.workspaceId === workspaceId).length;
}

// ─── Conflict resolution + local wipe + snapshots ──────────────────────

async function snapshotLocalWorkspace(workspaceId: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapDir = join(resolveLocalStoreDir(workspaceId), "snapshots", `${workspaceId}-${ts}`);
  await fs.mkdir(snapDir, { recursive: true });
  for (const name of ["categories.json", "channels.json", "sequences.json", "channel-settings.json"]) {
    try {
      await fs.copyFile(join(resolveLocalStoreDir(workspaceId), name), join(snapDir, name));
    } catch {
      // missing file — nothing to snapshot
    }
  }
  try {
    await fs.cp(join(resolveLocalStoreDir(workspaceId), "messages"), join(snapDir, "messages"), { recursive: true });
  } catch {
    // no message logs — nothing to snapshot
  }
  // Canon: the roster is one file per agent, so snapshot the whole agents dir.
  try {
    await fs.cp(resolveWorkspaceAgentsDir(workspaceId), join(snapDir, "agents"), { recursive: true });
  } catch {
    // no agents — nothing to snapshot
  }
  return snapDir;
}

/** Wipe one workspace's local rows (channels/categories/messages/counters/outbox). */
export async function clearWorkspaceLocalData(workspaceId: string): Promise<void> {
  await mutateJsonArray<LocalCategoryRow>("categories.json", (rows) =>
    rows.filter((r) => (r.workspaceId ?? "default") !== workspaceId), workspaceId);
  const removedChannelIds: string[] = [];
  await mutateJsonArray<LocalChannelRow>("channels.json", (rows) => {
    const kept = rows.filter((r) => {
      if ((r.workspaceId ?? "default") === workspaceId) {
        removedChannelIds.push(r.id);
        return false;
      }
      return true;
    });
    return kept;
  }, workspaceId);
  // Isolation: wipe only this workspace's scoped agents; legacy-global
  // (null workspaceId) rows survive — they belong to every workspace.
  // Canon: the roster is one file per agent, so scoped rows are deleted file by
  // file; legacy-global rows (no workspaceId) are left in place.
  {
    const rows = await agentGate.listLocalAgentRows(workspaceId).catch(() => [] as LocalAgentRow[]);
    for (const row of rows) {
      if ((row.workspaceId ?? null) === null) continue;
      if ((row.workspaceId ?? "default") !== workspaceId) continue;
      const file = join(resolveWorkspaceAgentsDir(workspaceId), row.id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
      await deleteFile(file).catch(() => {});
    }
  }
  for (const cid of removedChannelIds) {
    try {
      await fs.unlink(join(resolveLocalStoreDir(workspaceId), "messages", `${cid.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`));
    } catch {
      // already gone
    }
    await mutateJsonObject<number>("sequences.json", (obj) => {
      delete obj[`ch:${cid}`];
    }, workspaceId).catch(() => {});
  }
  await clearWorkspaceOutbox(workspaceId);
}

export type ConflictChoice = "flush-local" | "flush-db" | "change-db";

export async function resolveDbConflict(workspaceId: string, choice: ConflictChoice): Promise<{ ok: true; detail: string }> {
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  if (!record) throw new Error(`Workspace ${workspaceId} not found`);
  if (choice === "change-db") {
    const snapDir = await snapshotLocalWorkspace(workspaceId);
    record.databaseUrl = "";
    record.dbSync = null;
    await saveWorkspaceRecord(record);
    await closeWorkspaceDatabase(workspaceId).catch(() => {});
    return { ok: true as const, detail: `disconnected database; serving local only (snapshot: ${snapDir})` };
  }
  if (choice === "flush-local") {
    const snapDir = await snapshotLocalWorkspace(workspaceId);
    await clearWorkspaceLocalData(workspaceId);
    await pullWorkspaceFromDb(workspaceId, { force: true });
    record.dbSync = { dbWorkspaceId: record.dbSync?.dbWorkspaceId ?? workspaceId, state: "paired", updatedAt: nowIso() };
    await saveWorkspaceRecord(record);
    return { ok: true as const, detail: `replaced local state with database content (snapshot: ${snapDir})` };
  }
  // flush-db: local wins — local-wins push then pair. No record URL means
  // there is no database to push to (record-only; never the env pool).
  if (!record.databaseUrl?.trim()) {
    record.dbSync = { dbWorkspaceId: null, state: "paired", updatedAt: nowIso() };
    await saveWorkspaceRecord(record);
    return { ok: true as const, detail: "no database assigned to this workspace; serving local only" };
  }
  await convergeWorkspace(workspaceId);
  record.dbSync = { dbWorkspaceId: record.dbSync?.dbWorkspaceId ?? workspaceId, state: "paired", updatedAt: nowIso() };
  await saveWorkspaceRecord(record);
  return { ok: true as const, detail: "pushed local state to database and paired" };
}

// ─── RAG rebuild (non-blocking prompt action) ──────────────────────────

export async function rebuildWorkspaceRag(workspaceId: string): Promise<{
  ok: boolean;
  indexed: number;
  failed: number;
  memories: "deferred";
  reason?: string;
}> {
  if (!globalBroker) return { ok: false, indexed: 0, failed: 0, memories: "deferred", reason: "no live broker (socket server not running here)" };
  const librarian = await agentGate.getById("agent-librarian").catch(() => null);
  if (!librarian) return { ok: false, indexed: 0, failed: 0, memories: "deferred", reason: "no librarian agent row" };
  const runtime = new LibrarianRuntime();
  const chans = (await readJsonArray<LocalChannelRow>("channels.json", workspaceId).catch(() => []))
    .filter((c) => (c.workspaceId ?? "default") === workspaceId);
  // In dual mode the channel list lives in PG — merge both tiers by id.
  let targets = chans;
  try {
    const { db } = await getWorkspaceDb(workspaceId);
    const pgChans = await (db as any).query.channels.findMany({}).catch(() => []);
    const seen = new Set(chans.map((c) => c.id));
    targets = [...chans, ...pgChans.filter((c: any) => !seen.has(c.id))];
  } catch {
    // local list stands
  }
  let indexed = 0;
  let failed = 0;
  for (const c of targets) {
    try {
      await runtime.indexChannel(globalBroker, librarian as any, c.id);
      indexed++;
    } catch {
      failed++;
    }
  }
  return { ok: true, indexed, failed, memories: "deferred" };
}
