// SYNC-1 auto schema sync: binding a database must converge its schema, and
// readiness must be visible (GET db-sync) instead of surfacing as 500s.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ENV = join(mkdtempSync(join(tmpdir(), "crowdos-wssync-")), ".env");
const TEST_REGISTRY = join(mkdtempSync(join(tmpdir(), "crowdos-wssyncreg-")), "workspaces.json");

type Row = Record<string, unknown>;
const workspaceRows: Row[] = [];

function drizzleTableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../shared/config/database.js")>();
  return {
  getDb: () => ({
    insert: (table: unknown) => ({ values: async (vals: Row) => { if (drizzleTableName(table) === "workspaces") workspaceRows.push({ ...vals }); return { ...vals }; } }),
    update: (_table: unknown) => ({ set: (patch: Row) => ({ where: async () => { for (const row of workspaceRows) Object.assign(row, patch); return workspaceRows; } }) }),
    delete: (_table: unknown) => ({ where: async () => { workspaceRows.length = 0; return []; } }),
    query: { workspaces: { findFirst: async () => (workspaceRows.length > 0 ? { ...workspaceRows[workspaceRows.length - 1] } : null), findMany: async () => workspaceRows.map((r) => ({ ...r })) } },
  }),
  getSqlClient: () => { throw new Error("not available in route tests"); },
  closeDatabaseConnection: async () => {},
  ensurePgVectorExtension: async () => {},
  withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
  resolveTier: orig.resolveTier,
  isUrlReachable: orig.isUrlReachable,
  isConnectionError: orig.isConnectionError,
  isSchemaMismatchError: orig.isSchemaMismatchError,
  NO_DATABASE_CODE: orig.NO_DATABASE_CODE,
  };
});

vi.mock("../Filesystem/filesystem-gate.js", () => ({
  LocalFilesystem: class { constructor(_opts: unknown) {} async initialize() {} },
  isInsideRoot: (candidate: string, root: string) => { const c = candidate.replace(/\\/g, "/").toLowerCase(); const r = root.replace(/\\/g, "/").toLowerCase(); return c === r || c.startsWith(r + "/"); },
}));

vi.mock("postgres", () => ({ default: (_url: string) => { const tag: any = async () => [{ ok: 1 }]; tag.end = async () => {}; return tag; } }));

import { validatorCompiler } from "../shared/core/validation.js";
import { clearWorkspaceEnvCache } from "./workspace-database.js";
import { setRegistryFilePathForTests } from "./workspace-registry.js";
import { checkWorkspaceSchemaReady, invalidateWorkspaceSchemaProbe } from "./workspace-gate.js";
import { workspaceRoutes } from "../routes/workspace.js";

const GOOD_URL = "postgresql://alice:s3cret@db.internal:5432/appdb";

async function buildApp() { const app = Fastify(); app.setValidatorCompiler(validatorCompiler); await workspaceRoutes(app); await app.ready(); return app; }

beforeEach(() => {
  workspaceRows.length = 0;
  writeFileSync(TEST_REGISTRY, JSON.stringify({ workspaces: [] }));
  setRegistryFilePathForTests(TEST_REGISTRY);
  vi.stubEnv("CROWDOS_WS_ENV_FILE", TEST_ENV);
  vi.stubEnv("CROWDOS_WORKSPACE_REGISTRY_FILE", TEST_REGISTRY);
  writeFileSync(TEST_ENV, "PORT=12077\n");
  clearWorkspaceEnvCache(TEST_ENV);
});

afterEach(async () => { setRegistryFilePathForTests(null); clearWorkspaceEnvCache(TEST_ENV); vi.unstubAllEnvs(); });

function readRegistry(): any[] { return JSON.parse(readFileSync(TEST_REGISTRY, "utf8")).workspaces; }

describe("SYNC-1 auto schema sync", { timeout: 15000 }, () => {
  it("probe reports honest unknown for workspaces it cannot resolve", async () => {
    const probe = await checkWorkspaceSchemaReady("ws_does_not_exist");
    expect(probe.ready).toBeNull();
    expect(probe.missing).toEqual([]);
    expect(() => invalidateWorkspaceSchemaProbe("ws_does_not_exist")).not.toThrow();
    expect(() => invalidateWorkspaceSchemaProbe()).not.toThrow();
  });

  it("GET db-sync exposes schemaReady without ever throwing", async () => {
    const app = await buildApp();
    try {
      const missing = await app.inject({ method: "GET", url: "/api/workspaces/ws_nope/db-sync" });
      expect(missing.statusCode).toBe(404);
      const created = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Sync WS", databaseUrl: GOOD_URL } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const sync = await app.inject({ method: "GET", url: `/api/workspaces/${id}/db-sync` });
      expect(sync.statusCode).toBe(200);
      const body = sync.json();
      expect(body.dbConfigured).toBe(true);
      expect("schemaReady" in body).toBe(true);
      expect(Array.isArray(body.schemaMissing)).toBe(true);
    } finally { await app.close(); }
  });

  it("PATCH bind still succeeds when the schema sync cannot complete, and reports it", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Bind WS", databaseUrl: GOOD_URL } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const rebound = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, payload: { databaseUrl: "postgresql://bob:pw2@other:5433/db2" } });
      expect(rebound.statusCode).toBe(200);
      const body = rebound.json();
      expect(body.metadata.database).toMatchObject({ configured: true, host: "other" });
      expect(readRegistry().find((w) => w.id === id)?.databaseUrl).toBe("postgresql://bob:pw2@other:5433/db2");
      expect("schemaReady" in body).toBe(true);
      expect("schemaError" in body).toBe(true);
    } finally { await app.close(); }
  });
});
