// Route-boundary regressions for the channels feature (fix-channels batch):
//   CHN-004  POST/PATCH duplicate_name → 409 (distinct from 400 category)
//   CHN-006b duplicate category POST → 409 (was an unhandled 500)
//   CHN-012  PATCH settings for an unknown channel → 404 (no orphan pins)
//
// Hermetic: real routes + real gate, local tier via a temp store dir and an
// empty registry file (no live PG anywhere).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";

// No live DB: unset the env singleton so any unbound getDb() fails fast.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { validatorCompiler } from "../shared/core/validation.js";
import { channelRoutes } from "../routes/channels.js";
import { categoryRoutes } from "../routes/categories.js";

const WS = "ws-route";
let dir: string;
let regDir: string;

async function makeApp(db?: any) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  // Test-local tenant wiring (the real hook lives in create-app.ts): pin the
  // workspace scope so the routes exercise the local-tier service path.
  app.addHook("onRequest", async (request) => {
    (request as any).workspaceId = WS;
    if (db) (request as any).db = db;
  });
  await channelRoutes(app);
  await categoryRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-routes-"));
  regDir = mkdtempSync(join(tmpdir(), "crowdos-routes-reg-"));
  setLocalStoreDirForTests(dir);
  writeFileSync(join(regDir, "workspaces.json"), JSON.stringify({ workspaces: [] }), "utf8");
  setRegistryFilePathForTests(join(regDir, "workspaces.json"));
  return () => {
    setLocalStoreDirForTests(null);
    setRegistryFilePathForTests(null);
    rmSync(dir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  };
});

describe("channel route error contract (CHN-004)", () => {
  it("rejects numeric offsets above the documented cap with keyset guidance", async () => {
    const app = await makeApp();
    const result = await app.inject({ method: "GET", url: "/api/channels?offset=10001" });

    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({
      error: "Bad Request",
      message: "Numeric channel offsets are limited to 10000; use a position:id cursor for deeper pages.",
    });
    await app.close();
  });

  it("keeps offsets above the union cap for an explicit database handle", async () => {
    const row = {
      id: "db-offset-route-row",
      categoryId: null,
      workspaceId: WS,
      folderPath: null,
      name: "database row",
      type: "standard",
      createdBy: "system",
      position: 0,
      createdAt: new Date(0),
      archivedAt: null,
      archivedReason: null,
    };
    let queryOptions: any;
    const db = {
      query: {
        channels: {
          findMany: async (opts: any) => {
            queryOptions = opts;
            return [row];
          },
        },
      },
    };
    const app = await makeApp(db);
    const result = await app.inject({ method: "GET", url: "/api/channels?limit=1&offset=10001" });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([{ ...row, createdAt: new Date(0).toISOString() }]);
    expect(queryOptions.offset).toBe(10001);
    await app.close();
  });

  it("POST duplicate_name answers 409 while an unknown category answers 400", async () => {
    const app = await makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("already exists");

    const badCat = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { name: "other", type: "standard", createdBy: "system", categoryId: "no-such-cat", position: 0 },
    });
    expect(badCat.statusCode).toBe(400);
    expect(badCat.json().message).toContain("Category not found");

    await app.close();
  });

  it("PATCH rename-into-existing answers 409 (CHN-001 via HTTP)", async () => {
    const app = await makeApp();
    const alpha = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { name: "alpha", type: "standard", createdBy: "system", categoryId: null, position: 0 },
    });
    const beta = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { name: "beta", type: "standard", createdBy: "system", categoryId: null, position: 0 },
    });
    expect(alpha.statusCode).toBe(201);

    const clash = await app.inject({
      method: "PATCH",
      url: `/api/channels/${beta.json().id}`,
      payload: { name: "alpha" },
    });
    expect(clash.statusCode).toBe(409);

    await app.close();
  });
});

describe("category route error contract (CHN-006b)", () => {
  it("duplicate category create answers 409 instead of 500", async () => {
    const app = await makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/categories",
      payload: { name: "General", createdBy: "system" },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/api/categories",
      payload: { name: "general", createdBy: "system" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("already exists");

    await app.close();
  });
});

describe("settings route orphan guard (CHN-012)", () => {
  it("PATCH settings for an unknown channel answers 404 and writes nothing", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/channels/no-such-channel/settings",
      payload: { pinnedRuntime: "coding" },
    });
    expect(res.statusCode).toBe(404);

    // No orphan pin row landed in the local store.
    const { localGetChannelSettings } = await import("./channel-local-store.js");
    expect(await localGetChannelSettings("no-such-channel", WS)).toBeNull();

    await app.close();
  });
});
