// ─── Thread Local Store (THR-003, C3 local-first) ─────────────────────────
// File truth for threads when no DATABASE_URL is configured, mirroring
// message-local-store.ts:
//
//   <workspaceFolder>/vfs/.crowdos/threads/<channelId>.jsonl
//
// Threads are keyed by channel (list is channel-scoped); each row carries
// its own id. Thread replies stay in the messages local tier (threadId set).
// ponytail: O(n) scans per read; single-user local mode only.

import { mutateJsonArray, readJsonArray } from "../shared/core/local-file.js";

export interface LocalThreadRow {
  id: string;
  channelId: string;
  parentMessageId: string | null;
  rootMessageId: string | null;
  title: string | null;
  createdBy: string;
  isEphemeral: boolean;
  status: string;
  expiresAt: string | null;
  archivedAt: string | null;
  messageCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string | null;
}

function fileFor(channelId: string): string {
  return `threads/${channelId}.json`;
}

function revive(row: LocalThreadRow): any {
  return {
    ...row,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    lastActivityAt: new Date(row.lastActivityAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function serialize(row: Record<string, any>): LocalThreadRow {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? new Date().toISOString()));
  const nullIso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    return v instanceof Date ? v.toISOString() : String(v);
  };
  return {
    id: String(row.id),
    channelId: String(row.channelId),
    parentMessageId: row.parentMessageId ?? null,
    rootMessageId: row.rootMessageId ?? null,
    title: row.title ?? null,
    createdBy: String(row.createdBy ?? "local-user"),
    isEphemeral: Boolean(row.isEphemeral ?? true),
    status: String(row.status ?? "active"),
    expiresAt: nullIso(row.expiresAt),
    archivedAt: nullIso(row.archivedAt),
    messageCount: Number(row.messageCount ?? 0),
    lastActivityAt: iso(row.lastActivityAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    workspaceId: row.workspaceId ?? null,
  };
}

/** All thread rows for a channel, newest-activity-first. */
export async function localListThreads(channelId: string, opts?: { includeArchived?: boolean; workspaceId?: string | null }): Promise<any[]> {
  const rows = await readJsonArray<LocalThreadRow>(fileFor(channelId), opts?.workspaceId ?? null);
  const inChannel = rows.filter((r) => (r as unknown as LocalThreadRow).channelId === channelId);
  const filtered = opts?.includeArchived ? inChannel : inChannel.filter((r) => (r as unknown as LocalThreadRow).status === "active");
  filtered.sort((a, b) => {
    const ma = a as unknown as LocalThreadRow;
    const mb = b as unknown as LocalThreadRow;
    const tsDiff = new Date(mb.lastActivityAt).getTime() - new Date(ma.lastActivityAt).getTime();
    if (tsDiff !== 0) return tsDiff;
    return mb.id.localeCompare(ma.id);
  });
  return filtered.map((r) => revive(r as unknown as LocalThreadRow));
}

export async function localGetThread(id: string, channelId: string, workspaceId?: string | null): Promise<any | null> {
  const rows = await readJsonArray<LocalThreadRow>(fileFor(channelId), workspaceId ?? null);
  const found = rows.find((r) => (r as unknown as LocalThreadRow).id === id);
  return found ? revive(found as unknown as LocalThreadRow) : null;
}

export async function localFindThreadByParent(parentMessageId: string, channelId: string, workspaceId?: string | null): Promise<any | null> {
  const rows = await readJsonArray<LocalThreadRow>(fileFor(channelId), workspaceId ?? null);
  const found = rows.find((r) => (r as unknown as LocalThreadRow).parentMessageId === parentMessageId);
  return found ? revive(found as unknown as LocalThreadRow) : null;
}

/** Upsert by id within the channel file. */
export async function localUpsertThread(row: Record<string, any>, workspaceId?: string | null): Promise<any> {
  const stored = serialize(row);
  await mutateJsonArray<LocalThreadRow>(fileFor(stored.channelId), (rows) => {
    const idx = rows.findIndex((r) => r.id === stored.id);
    if (idx === -1) rows.push(stored);
    else rows[idx] = stored;
  }, workspaceId ?? stored.workspaceId);
  return revive(stored);
}

/** Remove by id; returns true when a row existed. */
export async function localDeleteThread(id: string, channelId: string, workspaceId?: string | null): Promise<boolean> {
  let removed = false;
  await mutateJsonArray<LocalThreadRow>(fileFor(channelId), (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) {
      rows.splice(idx, 1);
      removed = true;
    }
  }, workspaceId ?? null);
  return removed;
}
