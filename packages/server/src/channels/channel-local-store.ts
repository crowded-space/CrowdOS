// ─── Channel/Category Local Store (C3 local-first) ─────────────────────
// File truth for categories + channels when no DATABASE_URL is configured.
// Shapes mirror db/schema.ts rows with ISO-string dates (revived on read).
// ponytail: global files, O(n) scans — single-user local mode only.

import { randomUUID } from "node:crypto";
import { mutateJsonArray, readJsonArray } from "../shared/core/local-file.js";

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
}

const CATEGORIES_FILE = "categories.json";
const CHANNELS_FILE = "channels.json";

function reviveCategory(row: LocalCategoryRow): any {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function reviveChannel(row: LocalChannelRow): any {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
  };
}

// ─── Categories ────────────────────────────────────────────────────────

export async function localListCategories(workspaceId?: string | null): Promise<any[]> {
  const rows = await readJsonArray<LocalCategoryRow>(CATEGORIES_FILE);
  const filtered = workspaceId ? rows.filter((r) => r.workspaceId === workspaceId) : rows;
  return filtered
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(reviveCategory);
}

export async function localGetCategory(id: string): Promise<any | null> {
  const rows = await readJsonArray<LocalCategoryRow>(CATEGORIES_FILE);
  const found = rows.find((r) => r.id === id);
  return found ? reviveCategory(found) : null;
}

export async function localCreateCategory(input: {
  name: string;
  workspaceId?: string | null;
  ownedByAgentId?: string | null;
  embeddingProfileId?: string | null;
  createdBy: string;
  position?: number;
}): Promise<any> {
  const now = new Date().toISOString();
  const row: LocalCategoryRow = {
    id: randomUUID(),
    name: input.name,
    workspaceId: input.workspaceId ?? "default",
    folderPath: null,
    ownedByAgentId: input.ownedByAgentId ?? null,
    embeddingProfileId: input.embeddingProfileId ?? null,
    createdBy: input.createdBy,
    position: input.position ?? 0,
    createdAt: now,
  };
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    rows.push(row);
  });
  return reviveCategory(row);
}

export async function localUpdateCategory(
  id: string,
  patch: Partial<Pick<LocalCategoryRow, "name" | "ownedByAgentId" | "embeddingProfileId" | "position" | "folderPath" | "workspaceId">>,
): Promise<any | null> {
  let updated: LocalCategoryRow | null = null;
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows[idx] = { ...rows[idx], ...patch, id: rows[idx].id };
    updated = rows[idx];
  });
  return updated ? reviveCategory(updated) : null;
}

export async function localRemoveCategory(id: string): Promise<boolean> {
  let removed = false;
  await mutateJsonArray<LocalCategoryRow>(CATEGORIES_FILE, (rows) => {
    const next = rows.filter((r) => r.id !== id);
    removed = next.length !== rows.length;
    return next;
  });
  if (removed) {
    // Cascade: channels in the category go with it (PG ON DELETE CASCADE parity).
    await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (rows) => rows.filter((r) => r.categoryId !== id));
  }
  return removed;
}

// ─── Channels ──────────────────────────────────────────────────────────

export async function localListChannels(opts?: { limit?: number; cursor?: string | null }): Promise<any[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  let offset = 0;
  if (opts?.cursor) {
    const parsed = Number(opts.cursor);
    if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
  }
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE);
  return rows
    .filter((r) => r.archivedAt === null)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .slice(offset, offset + limit)
    .map(reviveChannel);
}

export async function localGetChannel(id: string): Promise<any | null> {
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE);
  const found = rows.find((r) => r.id === id);
  return found ? reviveChannel(found) : null;
}

export async function localCategoryExists(categoryId: string): Promise<boolean> {
  return (await localGetCategory(categoryId)) !== null;
}

export async function localCreateChannel(input: {
  name: string;
  type: string;
  createdBy: string;
  categoryId?: string | null;
  workspaceId?: string | null;
  position?: number;
}): Promise<{ channel?: any; error?: "category" | "duplicate_name"; categoryId?: string; name?: string }> {
  if (input.categoryId) {
    if (!(await localCategoryExists(input.categoryId))) {
      return { error: "category", categoryId: input.categoryId };
    }
  }
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE);
  const dupe = rows.find(
    (r) =>
      r.name.trim().toLowerCase() === input.name.trim().toLowerCase() &&
      (r.categoryId ?? null) === (input.categoryId ?? null),
  );
  if (dupe) return { error: "duplicate_name", name: input.name };

  const now = new Date().toISOString();
  const row: LocalChannelRow = {
    id: randomUUID(),
    categoryId: input.categoryId ?? null,
    workspaceId: input.workspaceId ?? "default",
    folderPath: null,
    name: input.name,
    type: input.type,
    createdBy: input.createdBy,
    position: input.position ?? 0,
    createdAt: now,
    archivedAt: null,
    archivedReason: null,
  };
  await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (existing) => {
    existing.push(row);
  });
  return { channel: reviveChannel(row) };
}

export async function localUpdateChannel(
  id: string,
  patch: { categoryId?: string | null; name?: string; position?: number; type?: string; folderPath?: string | null },
): Promise<{ channel?: any; error?: "category"; categoryId?: string; notFound?: true }> {
  if (patch.categoryId) {
    if (!(await localCategoryExists(patch.categoryId))) {
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
    if (patch.type !== undefined) {
      next.type = patch.type;
      next.archivedAt = patch.type === "archived" ? new Date().toISOString() : null;
    }
    rows[idx] = next;
    updated = next;
  });
  if (!updated) return { notFound: true };
  return { channel: reviveChannel(updated) };
}

export async function localDeleteChannel(id: string): Promise<{ deleted?: true; notFound?: true; conflictGeneral?: true }> {
  const rows = await readJsonArray<LocalChannelRow>(CHANNELS_FILE);
  const existing = rows.find((r) => r.id === id);
  if (!existing) return { notFound: true };
  if (existing.categoryId === null && existing.name.toLowerCase() === "general") {
    return { conflictGeneral: true };
  }
  await mutateJsonArray<LocalChannelRow>(CHANNELS_FILE, (all) => all.filter((r) => r.id !== id));
  return { deleted: true };
}

/** Categories with nested channels (routes/categories.ts list shape parity). */
export async function localListCategoriesWithChannels(opts?: {
  limit?: number;
  offset?: number;
  workspaceId?: string | null;
}): Promise<any[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const offset = Math.max(0, opts?.offset ?? 0);
  const [cats, chans] = await Promise.all([
    localListCategories(opts?.workspaceId),
    readJsonArray<LocalChannelRow>(CHANNELS_FILE),
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
