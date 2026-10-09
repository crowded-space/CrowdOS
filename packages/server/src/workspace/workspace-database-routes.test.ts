import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-scope temp dir (NOT vi.hoisted — hoisted factories run before static
// imports initialize). The mock below only closes over TEST_ENV and is first
// *called* at request time, long after module evaluation.
const TEST_ENV = join(mkdtempSync(join(tmpdir(), "crowdos-wsroutes-")), ".env");
const TEST_REGISTRY = join(mkdtempSync(join(tmpdir(), "crowdos-wsregistry-")), "workspaces.json");

type Row = Record<string, unknown>;
const workspaceRows: Row[] = [];

function drizzleTableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({
    insert: (table: unknown) => ({
      values: async (vals: Row) => {
        if (drizzleTableName(table) === "workspaces") workspaceRows.push({ ...vals });
        return { ...vals };
      },
    }),
    update: (_table: unknown) => ({
      set: (patch: Row) => ({
        where: async () => {
          for (const row of workspaceRows) Object.assign(row, patch);
          return workspaceRows;
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: async () => {
        workspaceRows.length = 0;
        return [];
      },
    }),
    query: {
      workspaces: {
        findFirst: async () =>
          workspaceRows.length > 0 ? { ...workspaceRows[workspaceRows.length - 1] } : null,
        findMany: async () => workspaceRows.map((r) => ({ ...r })),
      },
    },
  }),
  getSqlClient: () => {
    throw new Error("not available in route tests");
  },
  closeDatabaseConnection: async () => {},
  ensurePgVectorExtension: async () => {},
  withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
}));

vi.mock("../Filesystem/filesystem-gate.js", () => ({
  LocalFilesystem: class {
    constructor(_opts: unknown) {}
    async initialize() {}
  },
  isInsideRoot: (candidate: string, root: string) => {
    const c = candidate.replace(/\\/g, "/").toLowerCase();
    const r = root.replace(/\\/g, "/").toLowerCase();
    return c === r || c.startsWith(r + "/");
  },
}));

// NOTE: file location is steered via CROWDOS_WS_ENV_FILE (honored by
// resolveWorkspaceEnvFilePath itself, including for internal upsert/remove
// calls) — set with vi.stubEnv in beforeEach, NOT by mocking this module:
// a spread mock would only rebind what importers see, not internal bindings.

vi.mock("postgres", () => ({
  default: (url: string) => {
    const tag = (async () => {
      if (url.includes("badpw")) {
        const err = new Error('password authentication failed for user "u"') as any;
        err.code = "28P01";
        throw err;
      }
      return [{ ok: 1 }];
    }) as any;
    tag.end = async () => {};
    return tag;
  },
}));

import { validatorCompiler } from "../shared/core/validation.js";
import { clearWorkspaceEnvCache } from "./workspace-database.js";
import { resolveSandboxBase, setRegistryFilePathForTests } from "./workspace-registry.js";
import { workspaceRoutes } from "../routes/workspace.js";

const GOOD_URL = "postgresql://alice:s3cret@db.internal:5432/appdb";

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  await workspaceRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  workspaceRows.length = 0;
  writeFileSync(TEST_REGISTRY, JSON.stringify({ workspaces: [] }));
  setRegistryFilePathForTests(TEST_REGISTRY);
  vi.stubEnv("CROWDOS_WS_ENV_FILE", TEST_ENV);
  vi.stubEnv("CROWDOS_WORKSPACE_REGISTRY_FILE", TEST_REGISTRY);
  writeFileSync(TEST_ENV, "PORT=12077\n");
  clearWorkspaceEnvCache(TEST_ENV);
});

afterEach(async () => {
  setRegistryFilePathForTests(null);
  clearWorkspaceEnvCache(TEST_ENV);
  vi.unstubAllEnvs();
});

function readEnv(): string {
  return readFileSync(TEST_ENV, "utf8");
}

function readRegistry(): any[] {
  return JSON.parse(readFileSync(TEST_REGISTRY, "utf8")).workspaces;
}

describe("workspace BYODB routes", { timeout: 15000 }, () => {
  it("rejects a malformed database URL with 400 and creates nothing", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Bad WS", databaseUrl: "mysql://u:p@host/db" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/Invalid workspace database URL/);
      expect(workspaceRows).toHaveLength(0);
      expect(readEnv()).not.toContain("CROWDOS_WS_");
    } finally {
      await app.close();
    }
  });

  it("creates a workspace, persists the secret to the registry only, and never leaks it", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Good WS", databaseUrl: GOOD_URL },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.metadata.database).toMatchObject({ configured: true, host: "db.internal", database: "appdb" });
      expect(JSON.stringify(body)).not.toContain("s3cret");
      expect(body.envFile).toBeUndefined();
      expect(body.envKey).toBeUndefined();
      // WS-006: readiness is surfaced in the 201 payload. The mock postgres
      // cannot run drizzle migrate, so provisioning fails -> schemaReady false
      // (was: warn-only 201 with no readiness signal).
      expect(body.schemaReady).toBe(false);
      expect(body.seedReady).toBe(false);
      // ponytail: workspaces.json is the sole secret store; .env untouched.
      expect(readEnv()).not.toContain("CROWDOS_WS_");
      expect(readRegistry().find((w) => w.id === body.id)?.databaseUrl).toBe(GOOD_URL);
    } finally {
      await app.close();
    }
  });

  it("marks schemaReady/seedReady true for a DB-less workspace (no provision attempted)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Local WS" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // WS-006: registry-only workspaces have nothing to provision/seed in PG.
      expect(body.schemaReady).toBe(true);
      expect(body.seedReady).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("replaces the URL on PATCH and disconnects on null", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Swap WS", databaseUrl: GOOD_URL },
      });
      const id = created.json().id as string;

      const replaced = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${id}`,
        payload: { databaseUrl: "postgresql://bob:pw2@other:5433/db2" },
      });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json().metadata.database).toMatchObject({ configured: true, host: "other" });
      expect(readRegistry().find((w) => w.id === id)?.databaseUrl).toBe("postgresql://bob:pw2@other:5433/db2");
      expect(readEnv()).not.toContain("CROWDOS_WS_");

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${id}`,
        payload: { databaseUrl: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().metadata.database).toBeUndefined();
      expect(readRegistry().find((w) => w.id === id)?.databaseUrl).toBe("");
    } finally {
      await app.close();
    }
  });

  it("probes connectivity without persisting anything", async () => {
    const app = await buildApp();
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/api/workspaces/database/test",
        payload: { databaseUrl: GOOD_URL },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ success: true, host: "db.internal" });
      expect(readEnv()).not.toContain("CROWDOS_WS_");

      const denied = await app.inject({
        method: "POST",
        url: "/api/workspaces/database/test",
        payload: { databaseUrl: "postgresql://u:badpw@host/db" },
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().message).toMatch(/Authentication failed/);
      expect(JSON.stringify(denied.json())).not.toContain("badpw");

      const malformed = await app.inject({
        method: "POST",
        url: "/api/workspaces/database/test",
        payload: { databaseUrl: "not-a-url" },
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("removes the registry entry when the workspace is deleted", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Gone WS", databaseUrl: GOOD_URL },
      });
      const id = created.json().id as string;
      expect(readRegistry().some((w) => w.id === id)).toBe(true);

      const deleted = await app.inject({ method: "DELETE", url: `/api/workspaces/${id}` });
      expect(deleted.statusCode).toBe(200);
      expect(readRegistry().some((w) => w.id === id)).toBe(false);
      expect(readEnv()).not.toContain("CROWDOS_WS_");
    } finally {
      await app.close();
    }
  });
});

// WS-013: Zone A rule — an explicit rootPath outside the workspace sandbox is
// still honored (folder-picker flows) but must be flagged in the response so
// the portal can warn before CrowdOS sectors (vfs/, .crowdos/) are written
// into a user directory. In-sandbox paths stay unflagged. Create and patch
// both surface the flag.
describe("workspace rootPath containment (WS-013)", { timeout: 15000 }, () => {
  it("flags an outside-sandbox rootPath and leaves an in-sandbox rootPath unflagged (create)", async () => {
    const app = await buildApp();
    const outsideDir = mkdtempSync(join(tmpdir(), "crowdos-outside-"));
    const insideDir = join(resolveSandboxBase(), "Inside WS 013");
    try {
      const outside = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Outside WS", rootPath: outsideDir },
      });
      expect(outside.statusCode).toBe(201);
      expect(typeof outside.json().rootPathWarning).toBe("string");
      expect(outside.json().rootPathWarning).toMatch(/outside the workspace sandbox/);

      const inside = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Inside WS", rootPath: insideDir },
      });
      expect(inside.statusCode).toBe(201);
      expect(inside.json().rootPathWarning).toBeNull();
    } finally {
      await app.close();
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(insideDir, { recursive: true, force: true });
    }
  });

  it("flags an outside-sandbox rootPath and clears it for an in-sandbox rootPath (patch)", async () => {
    const app = await buildApp();
    const outsideDir = mkdtempSync(join(tmpdir(), "crowdos-outside-"));
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Patch WS 013" },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;

      const flagged = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${id}`,
        payload: { rootPath: outsideDir },
      });
      expect(flagged.statusCode).toBe(200);
      expect(typeof flagged.json().rootPathWarning).toBe("string");
      expect(flagged.json().rootPathWarning).toMatch(/outside the workspace sandbox/);

      const contained = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${id}`,
        payload: { rootPath: join(resolveSandboxBase(), "Patch Inside WS 013") },
      });
      expect(contained.statusCode).toBe(200);
      expect(contained.json().rootPathWarning).toBeNull();
    } finally {
      await app.close();
      rmSync(outsideDir, { recursive: true, force: true });
      // The record's derived folder and the patched in-sandbox rootPath both
      // get workspace.json mirrors written; keep the sandbox clean.
      rmSync(join(resolveSandboxBase(), "Patch WS 013"), { recursive: true, force: true });
      rmSync(join(resolveSandboxBase(), "Patch Inside WS 013"), { recursive: true, force: true });
    }
  });
});
