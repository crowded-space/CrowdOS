// ─── CM-001 / CM-002 regression tests (fix-cm-micro-001-002) ──────────
// CM-001 (Persistence / split-brain): registry record.mountPath is local
// truth, workspaces.metadata.customMountPath is the PG mirror. Resolve must
// backfill the missing side so a DATABASE_URL tier flip never hides a mount;
// PG attach/clear must write through to the registry.
// CM-002 (Security / jail): an unreadable registry fails closed to the
// sandbox base and must never widen the jail to sandbox + home.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted tier switch + in-memory workspaces table. `isDatabaseConfigured`
// is read live by the service, so flipping `tier` mid-test models the
// DATABASE_URL flip without re-importing the module graph.
const h = vi.hoisted(() => ({
  tier: "local" as "local" | "pg",
  workspaces: [] as Array<Record<string, unknown>>,
}));

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isDatabaseConfigured: () => h.tier === "pg",
    isConnectionError: () => false,
    getDb: () => ({
      query: {
        workspaces: {
          findFirst: async () => (h.workspaces[0] ? { ...h.workspaces[0] } : null),
        },
      },
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: async () => {
            if (h.workspaces[0]) Object.assign(h.workspaces[0], patch);
            return [];
          },
        }),
      }),
    }),
  };
});

import { channelMountGate } from "./channel-mount-gate.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";

const TEST_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "crowdos-cm-fix-")));
const TEST_REGISTRY = join(TEST_ROOT, "workspaces.json");
const TEST_SANDBOX = join(TEST_ROOT, "sandbox");
const REPO_A = join(TEST_ROOT, "home", "repo-a");
const REPO_B = join(TEST_ROOT, "home", "repo-b");
const NARROW = join(TEST_ROOT, "narrow");

/** Case/separator-insensitive path equality (win32-safe, mirrors gate tests). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function workspaceRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    icon: "box",
    databaseUrl: "",
    rootPath: join(TEST_SANDBOX, id),
    screenLockPinHash: null,
    allowedMountRoots: [TEST_ROOT],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function writeRegistry(records: Array<Record<string, unknown>>): void {
  writeFileSync(TEST_REGISTRY, JSON.stringify({ workspaces: records }, null, 2), "utf8");
}

function registryRecord(id: string): Record<string, unknown> | null {
  const parsed = JSON.parse(readFileSync(TEST_REGISTRY, "utf8")) as {
    workspaces: Array<Record<string, unknown>>;
  };
  return parsed.workspaces.find((w) => w.id === id) ?? null;
}

let prevWorkspaceDir: string | undefined;

beforeEach(() => {
  mkdirSync(TEST_SANDBOX, { recursive: true });
  mkdirSync(REPO_A, { recursive: true });
  mkdirSync(REPO_B, { recursive: true });
  prevWorkspaceDir = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = TEST_ROOT;
  h.tier = "local";
  h.workspaces = [];
  writeRegistry([workspaceRecord("ws-a"), workspaceRecord("ws-b")]);
  setRegistryFilePathForTests(TEST_REGISTRY);
});

afterEach(() => {
  setRegistryFilePathForTests(null);
  if (prevWorkspaceDir !== undefined) process.env.WORKSPACE_DIR = prevWorkspaceDir;
  else delete process.env.WORKSPACE_DIR;
});

describe("CM-002 · corrupt registry fails closed", () => {
  it("keeps the sandbox-base jail instead of widening to sandbox + home", async () => {
    writeRegistry([workspaceRecord("ws-corrupt", { allowedMountRoots: [NARROW] })]);
    setRegistryFilePathForTests(TEST_REGISTRY);
    expect(await channelMountGate.allowedRoots("ws-corrupt")).toEqual([NARROW]);

    // Corrupt the registry (invalid JSON) → the record is unreadable, not
    // absent. Clear the record cache so the next read hits the broken file.
    writeFileSync(TEST_REGISTRY, "{ not json", "utf8");
    setRegistryFilePathForTests(TEST_REGISTRY);

    const roots = await channelMountGate.allowedRoots("ws-corrupt");
    expect(roots).toEqual([TEST_ROOT]); // sandbox base only — fail closed
    expect(roots).not.toContain(homedir());

    // The home dir is inside the wide default jail but outside the fail-closed
    // jail, so it must be refused while the registry is unreadable.
    const res = await channelMountGate.validate(homedir(), "ws-corrupt");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("outside allowed roots");
  });
});

describe("CM-001 · registry ⇄ PG mount mirror across tier flips", () => {
  it("keeps a configured mount visible when DATABASE_URL appears and disappears", async () => {
    // Local tier: attach writes registry truth.
    h.tier = "local";
    const localAttach = await channelMountGate.attachWorkspace("ws-a", REPO_A);
    expect(localAttach.ok, JSON.stringify(localAttach)).toBe(true);
    const localResolve = await channelMountGate.resolveWorkspace("ws-a");
    expect(localResolve.mountedPath && samePath(localResolve.mountedPath, REPO_A)).toBe(true);

    // Flip to PG: the registry mount backfills the PG mirror instead of vanishing.
    h.tier = "pg";
    h.workspaces = [{ id: "ws-a", metadata: {} }];
    const pgResolve = await channelMountGate.resolveWorkspace("ws-a");
    expect(pgResolve.mountedPath && samePath(pgResolve.mountedPath, REPO_A)).toBe(true);
    expect(pgResolve.source).toBe("workspace");
    const meta = (h.workspaces[0].metadata ?? {}) as Record<string, unknown>;
    expect(typeof meta.customMountPath).toBe("string");

    // PG attach writes through to the registry mirror.
    h.workspaces = [{ id: "ws-b", metadata: {} }];
    const pgAttach = await channelMountGate.attachWorkspace("ws-b", REPO_B);
    expect(pgAttach.ok, JSON.stringify(pgAttach)).toBe(true);
    const mirror = registryRecord("ws-b")?.mountPath;
    expect(typeof mirror).toBe("string");
    expect(mirror && samePath(String(mirror), REPO_B)).toBe(true);

    // Flip back to local: the PG-attached mount survived the flip.
    h.tier = "local";
    const localAgain = await channelMountGate.resolveWorkspace("ws-b");
    expect(localAgain.mountedPath && samePath(localAgain.mountedPath, REPO_B)).toBe(true);

    // PG clear removes the mirror too, or a flip back would resurrect it.
    h.tier = "pg";
    h.workspaces = [{ id: "ws-b", metadata: {} }];
    const cleared = await channelMountGate.attachWorkspace("ws-b", null);
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(registryRecord("ws-b")?.mountPath ?? null).toBeNull();
    h.tier = "local";
    const localFinal = await channelMountGate.resolveWorkspace("ws-b");
    expect(localFinal.mountedPath).toBeNull();
  });
});
