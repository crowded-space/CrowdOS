// ART-6 + ART-8 regression guards (fix-artifacts-micro-6-8).
// ART-6: a caller-supplied dedupeKey makes create idempotent per workspace — a
// retry returns the existing row and writes no second file (sequential path;
// concurrent same-key races await a DB unique index, recorded as a gap).
// ART-8: create persists the WRITTEN folder-relative path only; the
// caller-supplied path is kept in metadata.sourcePath, so a failed write can
// never leave a repo-relative path in artifacts.path for apply to target.
// Hermetic: DB boundary faked; workspace folder redirected to a temp dir.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prevDatabaseUrl = process.env.DATABASE_URL;
  // Fallback for the real-module path: client construction is lazy, no I/O.
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/crowdos_artifacts_fix_test";
  return {
    prevDatabaseUrl,
    folder: null as string | null,
    lookupRows: [] as Array<Record<string, unknown>>,
    insertCount: 0,
    selectCount: 0,
  };
});

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config/database.js")>();
  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (n: number) => {
            h.selectCount++;
            return h.lookupRows.slice(0, n);
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          h.insertCount++;
          h.lookupRows = [v]; // simulate the row now living in the DB
          return [v];
        },
      }),
    }),
  };
  return { ...actual, getDb: () => fakeDb };
});

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  return {
    ...actual,
    resolveWorkspaceFolder: async () => h.folder,
    getWorkspaceRecord: async () => null,
  };
});

import { artifactsGate } from "./artifacts-gate.js";

const tempDirs: string[] = [];

async function freshFolder(): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "art68-"));
  tempDirs.push(dir);
  return dir;
}

function input(dedupeKey?: string) {
  return {
    runId: "run-1",
    workspaceId: "ws-art68",
    producerAgent: "art-agent",
    type: "report" as const,
    path: "src/x.ts",
    contentRef: "artifact body",
    ...(dedupeKey ? { dedupeKey } : {}),
  };
}

afterAll(async () => {
  if (h.prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = h.prevDatabaseUrl;
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

describe("artifacts create - ART-6 dedupeKey idempotency", () => {
  it("returns the existing row and writes no second file on a keyed retry", async () => {
    h.folder = await freshFolder();
    h.lookupRows = [];
    h.insertCount = 0;
    h.selectCount = 0;
    const first = await artifactsGate.create(input("retry-1"));
    expect(h.insertCount).toBe(1);
    expect((first.metadata as Record<string, unknown>).dedupeKey).toBe("retry-1");
    const runDir = join(h.folder, "vfs", "artifacts", "run-1");
    expect(await fs.readdir(runDir)).toHaveLength(1);

    const second = await artifactsGate.create(input("retry-1"));
    expect(second.id).toBe(first.id);
    expect(h.insertCount).toBe(1);
    expect(await fs.readdir(runDir)).toHaveLength(1);
  });

  it("skips the lookup entirely when no dedupeKey is supplied", async () => {
    h.folder = await freshFolder();
    h.lookupRows = [];
    h.insertCount = 0;
    h.selectCount = 0;
    await artifactsGate.create(input());
    expect(h.selectCount).toBe(0);
    expect(h.insertCount).toBe(1);
  });
});

describe("artifacts create - ART-8 path semantics", () => {
  it("persists the written path only; caller path stays in metadata.sourcePath", async () => {
    h.folder = await freshFolder();
    h.lookupRows = [];
    const row = await artifactsGate.create(input());
    expect(row.path).toMatch(/^vfs\/artifacts\/run-1\/art_/);
    expect(row.path).not.toBe("src/x.ts");
    expect((row.metadata as Record<string, unknown>).sourcePath).toBe("src/x.ts");
  });

  it("keeps path null and sourcePath in metadata when the write fails", async () => {
    h.folder = null; // write failure: no resolvable workspace folder
    h.lookupRows = [];
    const row = await artifactsGate.create(input());
    expect(row.path).toBeNull();
    expect((row.metadata as Record<string, unknown>).sourcePath).toBe("src/x.ts");
    expect((row.metadata as Record<string, unknown>).artifactPath).toBeUndefined();
  });
});
