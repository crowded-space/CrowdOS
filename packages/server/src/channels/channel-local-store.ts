// ─── Channel/Category Local Store (C3 local-first) ─────────────────────
// File truth for categories + channels when no DATABASE_URL is configured.
//
// Canon (mock-structure-polished): these rows live INSIDE their workspace:
//
//   <workspaceFolder>/vfs/.crowdos/categories.json   ONLY place for categories
//   <workspaceFolder>/vfs/.crowdos/channels.json     ONLY place for channels
//   <workspaceFolder>/vfs/.crowdos/channel-settings.json
//
// Shapes mirror db/schema.ts rows with ISO-string dates (revived on read), plus
// the canon fsMounts descriptor { scope, mode, mounts[] }, where mode is
// "inherit" (follow the parent level) or "override" (use these mounts).
// ponytail: O(n) scans — single-user local mode only.

import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_SCOPE,
  mutateJsonArray,
  readJsonArray,
  searchableWorkspaceScopes,
} from "../shared/core/local-file.js";

/** Canon mount descriptor carried by categories and channels. */
export type FsMountScope = "workspace" | "category" | "channel";
export type FsMountMode = "default" | "inherit" | "override";

export interface FsMount {
  id: string;
  /** Virtual source path the agent sees (e.g. "/workspace/repository"). */
  source: string;
  /** Virtual target path the agent sees (e.g. "/mnt/repository"). */
  target: string;
  type: string;
  readOnly: boolean;
}

export interface FsMounts {
  scope: FsMountScope;
  mode: FsMountMode;
  mounts: FsMount[];
}

/** Canon default for a child level: follow the parent, declare no mounts. */
export function inheritMounts(scope: FsMountScope): FsMounts {
  return { scope, mode: "inherit", mounts: [] };
}

export interface LocalCategoryRow {
  id: string;
  name: string;
  workspaceId: string | null;
  folderPath: string | null;
  ownedByAgentId: string | null;
  embeddingProfileId: string | null;
  createdBy: string;
  position: number;
  createdAt: string;
  fsMounts?: FsMounts;
}

export interface LocalChannelRow {
  id: string;
  categoryId: string | null;
  workspaceId: string | null;
  folderPath: string | null;
  name: string;
  type: string;
  createdBy: string;
  position: number;
  createdAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
  fsMounts?: FsMounts;
}

const CATEGORIES_FILE = "categories.json";
const CHANNELS_FILE = "channels.json";
const CHANNEL_SETTINGS_FILE = "channel-settings.json";

export interface LocalChannelSettingsRow {
  channelId: string;
  /** §30 scope: the settings PK is (channelId, workspaceId), not channelId alone. */
  workspaceId: string;
  pinnedRuntime: string | null;
  activeAgentId: string | null;
  defaultAgentId: string | null;
  updatedAt: string;
}

function reviveCategory(row: LocalCategoryRow): any {
  return { ...row, createdAt: new Date(row.createdAt), fsMounts: row.fsMounts ?? inheritMounts("category") };
}

function reviveChannel(row: LocalChannelRow): any {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    fsMounts: row.fsMounts ?? inheritMounts("channel"),
  };
}

/** Workspace folders to search when the caller did not name one. */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  return workspaceId && workspaceId.trim() ? [workspaceId] : searchableWorkspaceScopes();
}

/**
 * Locate the FOLDER that physically holds a row, plus the row itself.
 *
 * Canon writes and reads use the same folder, so an update must target the
 * folder the row was found in — not the workspaceId the row merely declares.
 * Those differ for legacy rows (written before per-workspace files existed) and
 * for fixtures that seed a row with an explicit workspaceId into the default
 * folder. Targeting the declared id would write a second copy and leave the
 * original untouched.
 */
async function findCategory(id: string, workspaceId?: string | null): Promise<{ row: LocalCategoryRow; scope: string } | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<LocalCategoryRow>(CATEGORIES_FILE, scope).catch(() => []);
    const row = rows.find((r) => r.id === id);
    if (row) return { row, scope: scope ?? DEFAULT_WORKSPACE_SCOPE };
  }
  return null;
}

async function findChannel(id: string, workspaceId?: string | null): Promise<{ row: LocalChannelRow; scope: string } | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE, scope).catch(() => []);
    const row = rows.find((r) => r.id === id);
    if (row) return { row, scope: scope ?? DEFAULT_WORKSPACE_SCOPE };
  }
  return null;
}

// ─── Categories ────────────────────────────────────────────────────────

export async function localListCategories(workspaceId?: string | null): Promise<any[]> {
  const rows = await readJsonArray<LocalCategoryRow>(CATEGORIES_FILE, workspaceId);
  return rows
    .filter((r) => !workspaceId || !r.workspaceId || r.workspaceId === workspaceId)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(reviveCategory);
}

export async function localGetCategory(id: string, workspaceId?: string | null): Promise<any | null> {
  const found = await findCategory(id, workspaceId);
  return found ? reviveCategory(found.row) : null;
}

export async function localCreateCategory(input: {
  id?: string;
  name: string;
  workspaceId?: string | null;
  ownedByAgentId?: string | null;
  embeddingProfileId?: string | null;
  createdBy: string;
  position?: number;
  fsMounts?: FsMounts;
}): Promise<any> {
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  const row: LocalCategoryRow = {
    id: input.id ?? randomUUID(),
    name: input.name,
    workspaceId,
    folderPath: null,
    ownedByAgentId: input.ownedByAgentId ?? null,
    embeddingProfileId: input.embeddingProfileId ?? null,
    createdBy: input.createdBy,
    position: input.position ?? 0,
    createdAt: now,
    fsMounts: input.fsMounts ?? inheritMounts("category"),
  };
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    rows.push(row);
  }, workspaceId);
  return reviveCategory(row);
}

export async function localUpdateCategory(
  id: string,
  patch: Partial<Pick<LocalCategoryRow, "name" | "ownedByAgentId" | "embeddingProfileId" | "position" | "folderPath" | "workspaceId" | "fsMounts">>,
  workspaceId?: string | null,
): Promise<any | null> {
  const existing = await localGetCategory(id, workspaceId);
  const scope = (await findCategory(id, workspaceId))?.scope ?? workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  let updated: LocalCategoryRow | null = null;
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows[idx] = { ...rows[idx], ...patch, id: rows[idx].id };
    updated = rows[idx];
  }, scope);
  return updated ? reviveCategory(updated) : null;
}

export async function localRemoveCategory(id: string, workspaceId?: string | null): Promise<boolean> {
  const existing = await localGetCategory(id, workspaceId);
  const scope = (await findCategory(id, workspaceId))?.scope ?? workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  let removed = false;
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    const next = rows.filter((r) => r.id !== id);
    removed = next.length !== rows.length;
    return next;
  }, scope);
  if (removed) {
    // Cascade: channels in the category go with it (PG ON DELETE CASCADE parity).
    await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (rows) => rows.filter((r) => r.categoryId !== id), scope);
  }
  return removed;
}

// ─── Channels ──────────────────────────────────────────────────────────

export async function localListChannels(opts?: {
  limit?: number;
  cursor?: string | null;
  workspaceId?: string | null;
}): Promise<any[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  let offset = 0;
  if (opts?.cursor) {
    const parsed = Number(opts.cursor);
    if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
  }
  const workspaceId = opts?.workspaceId ?? null;
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE, workspaceId);
  return rows
    .filter((r) => !workspaceId || !r.workspaceId || r.workspaceId === workspaceId)
    .filter((r) => r.archivedAt === null)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .slice(offset, offset + limit)
    .map(reviveChannel);
}

export async function localGetChannel(id: string, workspaceId?: string | null): Promise<any | null> {
  const found = await findChannel(id, workspaceId);
  return found ? reviveChannel(found.row) : null;
}

export async function localCategoryExists(categoryId: string, workspaceId?: string | null): Promise<boolean> {
  return (await localGetCategory(categoryId, workspaceId)) !== null;
}

export async function localCreateChannel(input: {
  id?: string;
  name: string;
  type: string;
  createdBy: string;
  categoryId?: string | null;
  workspaceId?: string | null;
  position?: number;
  fsMounts?: FsMounts;
}): Promise<{ channel?: any; error?: "category" | "duplicate_name"; categoryId?: string; name?: string }> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  if (input.categoryId) {
    if (!(await localCategoryExists(input.categoryId, workspaceId))) {
      return { error: "category", categoryId: input.categoryId };
    }
  }
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE, workspaceId);
  const dupe = rows.find(
    (r) =>
      r.name.trim().toLowerCase() === input.name.trim().toLowerCase() &&
      (r.categoryId ?? null) === (input.categoryId ?? null),
  );
  if (dupe) return { error: "duplicate_name", name: input.name };

  const now = new Date().toISOString();
  const row: LocalChannelRow = {
    id: input.id ?? randomUUID(),
    categoryId: input.categoryId ?? null,
    workspaceId,
    folderPath: null,
    name: input.name,
    type: input.type,
    createdBy: input.createdBy,
    position: input.position ?? 0,
    createdAt: now,
    archivedAt: null,
    archivedReason: null,
    fsMounts: input.fsMounts ?? inheritMounts("channel"),
  };
  await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (existing) => {
    existing.push(row);
  }, workspaceId);
  return { channel: reviveChannel(row) };
}

export async function localUpdateChannel(
  id: string,
  patch: {
    categoryId?: string | null;
    name?: string;
    position?: number;
    type?: string;
    folderPath?: string | null;
    fsMounts?: FsMounts;
  },
  workspaceId?: string | null,
): Promise<{ channel?: any; error?: "category"; categoryId?: string; notFound?: true }> {
  const existing = await localGetChannel(id, workspaceId);
  const scope = (await findChannel(id, workspaceId))?.scope ?? workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  if (patch.categoryId) {
    if (!(await localCategoryExists(patch.categoryId, scope))) {
      return { error: "category", categoryId: patch.categoryId };
    }
  }
  let updated: LocalChannelRow | null = null;
  await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const next = { ...rows[idx] };
    if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
    if (patch.folderPath !== undefined) next.folderPath = patch.folderPath;
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.position !== undefined) next.position = patch.position;
    if (patch.fsMounts !== undefined) next.fsMounts = patch.fsMounts;
    if (patch.type !== undefined) {
      next.type = patch.type;
      next.archivedAt = patch.type === "archived" ? new Date().toISOString() : null;
    }
    rows[idx] = next;
    updated = next;
  }, scope);
  if (!updated) return { notFound: true };
  return { channel: reviveChannel(updated) };
}

export async function localDeleteChannel(
  id: string,
  workspaceId?: string | null,
): Promise<{ deleted?: true; notFound?: true; conflictGeneral?: true }> {
  const existing = await localGetChannel(id, workspaceId);
  const scope = (await findChannel(id, workspaceId))?.scope ?? workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  if (!existing) return { notFound: true };
  if (existing.categoryId === null && String(existing.name).toLowerCase() === "general") {
    return { conflictGeneral: true };
  }
  await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (all) => all.filter((r) => r.id !== id), scope);
  return { deleted: true };
}

// ─── Channel settings (§6-8 pins: runtime, active agent, default agent) ──
// §30: the settings PK is the (channelId, workspaceId) PAIR. Canon puts the file
// inside the workspace folder, so the file itself scopes the workspace and rows
// are keyed by channelId; workspaceId stays on the row for PG parity.

function settingsScope(workspaceId?: string | null): string {
  return workspaceId && workspaceId.trim() ? workspaceId : DEFAULT_WORKSPACE_SCOPE;
}

export async function localGetChannelSettings(
  channelId: string,
  workspaceId?: string | null,
): Promise<LocalChannelSettingsRow | null> {
  const scope = settingsScope(workspaceId);
  const rows = await readJsonArray<LocalChannelSettingsRow>(CHANNEL_SETTINGS_FILE, scope);
  return rows.find((r) => r.channelId === channelId) ?? null;
}

export async function localUpsertChannelSettings(
  channelId: string,
  patch: { pinnedRuntime?: string | null; activeAgentId?: string | null; defaultAgentId?: string | null },
  workspaceId?: string | null,
): Promise<LocalChannelSettingsRow> {
  const now = new Date().toISOString();
  const scope = settingsScope(workspaceId);
  let result: LocalChannelSettingsRow | null = null;
  await mutateJsonArray<LocalChannelSettingsRow>(CHANNEL_SETTINGS_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.channelId === channelId);
    if (idx === -1) {
      const created: LocalChannelSettingsRow = {
        channelId,
        workspaceId: scope,
        pinnedRuntime: patch.pinnedRuntime ?? null,
        activeAgentId: patch.activeAgentId ?? null,
        defaultAgentId: patch.defaultAgentId ?? null,
        updatedAt: now,
      };
      rows.push(created);
      result = created;
      return;
    }
    const next = { ...rows[idx], workspaceId: scope, updatedAt: now };
    if (patch.pinnedRuntime !== undefined) next.pinnedRuntime = patch.pinnedRuntime;
    if (patch.activeAgentId !== undefined) next.activeAgentId = patch.activeAgentId;
    if (patch.defaultAgentId !== undefined) next.defaultAgentId = patch.defaultAgentId;
    rows[idx] = next;
    result = next;
  }, scope);
  return result!;
}

/** Categories with nested channels (routes/categories.ts list shape parity). */
export async function localListCategoriesWithChannels(opts?: {
  limit?: number;
  offset?: number;
  workspaceId?: string | null;
}): Promise<any[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const offset = Math.max(0, opts?.offset ?? 0);
  const workspaceId = opts?.workspaceId ?? null;
  const [cats, chans] = await Promise.all([
    localListCategories(workspaceId),
    readJsonArray<LocalChannelRow>(CHANNELS_FILE, workspaceId),
  ]);
  return cats.slice(offset, offset + limit).map((cat) => ({
    ...cat,
    channels: chans
      .filter((c) => c.categoryId === cat.id)
      .sort((a, b) => a.position - b.position)
      .slice(0, 100)
      .map(reviveChannel),
  }));
}
