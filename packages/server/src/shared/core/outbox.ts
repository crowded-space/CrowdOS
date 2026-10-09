// ─── Dual-Boot Outbox (backfill backup) ─────────────────────────────────
// Durable FIFO of local writes made without a PG ack (outage fallback or
// Local-first mode with a DB attached). The drain replays entries into PG in
// order; every replay op is idempotent by construction (upsert-by-id,
// tombstone deletes, message insert-ignore), so concurrent drains are safe.
// ponytail: unbounded by design (local must never block); the Overview UI
// shows a yellow backlog notice past OUTBOX_NOTICE_THRESHOLD entries.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveLocalStoreDir, withStoreLock } from "./local-file.js";

export type OutboxEntity = "category" | "channel" | "channelSettings" | "agent" | "message";
export type OutboxOp = "upsert" | "delete";

export interface OutboxEntry {
  id: string;
  ts: string;
  workspaceId: string | null;
  entity: OutboxEntity;
  op: OutboxOp;
  rowId: string;
  row: Record<string, unknown> | null;
}

export const OUTBOX_NOTICE_THRESHOLD = 100;

let outboxSeq = 0;

function outboxFile(): string {
  return join(resolveLocalStoreDir(), "outbox.jsonl");
}

/** Queue a local write for later PG replay. Fire-and-forget safe (locked). */
export async function appendOutbox(entry: Omit<OutboxEntry, "id" | "ts">): Promise<void> {
  const full: OutboxEntry = {
    ...entry,
    id: `obx-${Date.now().toString(36)}-${(outboxSeq = (outboxSeq + 1) % 1_000_000)}`,
    ts: new Date().toISOString(),
  };
  await withStoreLock("outbox", async () => {
    const dir = resolveLocalStoreDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(outboxFile(), JSON.stringify(full) + "\n", "utf8");
  });
}

/** Read pending entries oldest-first (bounded). */
export async function readOutbox(limit = 500): Promise<OutboxEntry[]> {
  // Outbox lives at the store root, not under messages/ — read directly.
  let raw: string | null = null;
  try {
    raw = await fs.readFile(outboxFile(), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const entries: OutboxEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.id) entries.push(parsed as OutboxEntry);
    } catch {
      // skip torn trailing line
    }
    if (entries.length >= limit) break;
  }
  return entries;
}

/** Drop acked entries by id (locked rewrite). */
export async function removeOutboxIds(ids: ReadonlySet<string> | ReadonlyArray<string>): Promise<void> {
  const drop = new Set(ids);
  if (drop.size === 0) return;
  await withStoreLock("outbox", async () => {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(outboxFile(), "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        if (drop.has((JSON.parse(line) as OutboxEntry).id)) continue;
      } catch {
        continue;
      }
      kept.push(line);
    }
    await fs.writeFile(outboxFile(), kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
  });
}

/** Pending entry count (for the Overview backlog notice). */
export async function countOutbox(): Promise<number> {
  return (await readOutbox(Number.MAX_SAFE_INTEGER)).length;
}
