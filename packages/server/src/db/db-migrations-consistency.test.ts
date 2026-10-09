// DB-005 regression: journal tags <-> SQL files <-> snapshots must stay
// consistent. Migrations after 0010 are hand-written (meta snapshots frozen;
// see src/db/migrations/README.md) — this hermetic check is the CI gate that
// catches a new SQL file without a journal entry (or vice versa).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));

type journalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type journal = { version: string; dialect: string; entries: journalEntry[] };

const journal = JSON.parse(readFileSync(`${metaDir}/_journal.json`, "utf8")) as journal;
const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));
const snapshotFiles = readdirSync(metaDir)
  .filter((f) => f.endsWith("_snapshot.json"))
  .map((f) => f.replace(/_snapshot\.json$/, ""));

describe("DB-005 · migrations journal <-> SQL files <-> snapshots", () => {
  it("journal idx is a contiguous 0..N-1 sequence with unique tags", () => {
    const idx = journal.entries.map((e) => e.idx);
    expect(idx).toEqual(Array.from({ length: idx.length }, (_, i) => i));
    const tags = journal.entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("every journal tag has a matching SQL file and vice versa", () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.filter((t) => !sqlFiles.includes(t))).toEqual([]);
    expect(sqlFiles.filter((f) => !tags.includes(f))).toEqual([]);
  });

  it("journal `when` timestamps are non-decreasing", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThanOrEqual(journal.entries[i - 1].when);
    }
  });

  it("snapshots only cover journal tags (frozen at 0010; no orphan snapshot)", () => {
    // Snapshot files are named by idx (`0010_snapshot.json` -> "0010"), not by tag.
    const idxSet = new Set(journal.entries.map((e) => e.idx));
    expect(snapshotFiles.filter((s) => !idxSet.has(Number(s)))).toEqual([]);
    // Documented frozen state (DB-005 / migrations/README.md): newest snapshot is 0010.
    const maxSnapshotIdx = Math.max(...snapshotFiles.map((s) => Number(s.slice(0, 4))));
    expect(maxSnapshotIdx).toBe(10);
  });

  it("journal tail is the newest SQL file (today: 0028 drop scope_hash)", () => {
    const last = journal.entries[journal.entries.length - 1];
    const newestFile = [...sqlFiles].sort().at(-1);
    expect(last.tag).toBe(newestFile);
    expect(sqlFiles).toContain(last.tag);
  });
});
