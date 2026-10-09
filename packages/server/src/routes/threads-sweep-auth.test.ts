// THR-008: POST /api/threads/sweep is a cron surface that flips mass state.
// With WORKSPACE_ADMIN_TOKEN configured (the repo's admin-auth convention from
// routes/tools.ts + routes/observability.ts), the route must demand admin auth:
// no key => 401, non-admin key => 403, admin key => 200. Without the token the
// single-user loopback trust model stays (pinned by routes/index.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

const prevWorkspaceDir = process.env.WORKSPACE_DIR;
const prevRegistryFile = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
const prevAdminToken = process.env.WORKSPACE_ADMIN_TOKEN;

let app: any;
let stop: (() => Promise<void>) | undefined;
let adminKey = "";
let viewerKey = "";
let storeDir = "";

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), "crowdos-thr008-"));
  process.env.WORKSPACE_DIR = storeDir;
  process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = join(storeDir, "workspaces.json");
  setLocalStoreDirForTests(storeDir);
  // Set BEFORE buildServer: threadRoutes captures the admin gate at registration.
  process.env.WORKSPACE_ADMIN_TOKEN = "thr008-admin-secret";

  const { authGate } = await import("../shared/auth/auth-gate.js");
  adminKey = (await authGate.createApiKey({ label: "thr008-admin", role: "admin" })).key;
  viewerKey = (await authGate.createApiKey({ label: "thr008-viewer", role: "viewer" })).key;

  const { buildServer } = await import("../create-app.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
}, 60_000);

afterAll(async () => {
  await stop?.();
  setLocalStoreDirForTests(null);
  if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = prevWorkspaceDir;
  if (prevRegistryFile === undefined) delete process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
  else process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = prevRegistryFile;
  if (prevAdminToken === undefined) delete process.env.WORKSPACE_ADMIN_TOKEN;
  else process.env.WORKSPACE_ADMIN_TOKEN = prevAdminToken;
  (env as any).DATABASE_URL = prevDatabaseUrl;
  rmSync(storeDir, { recursive: true, force: true });
});

function sweep(headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/threads/sweep",
    headers,
    // Loopback peer: without the token this would be the trusted desktop
    // caller — with it, the route must still demand admin auth.
    remoteAddress: "127.0.0.1",
  });
}

describe("THR-008 sweep admin guard", () => {
  it("401s an unauthenticated loopback caller when WORKSPACE_ADMIN_TOKEN is set", async () => {
    const res = await sweep();
    expect(res.statusCode).toBe(401);
  });

  it("401s a wrong key and 403s a non-admin key", async () => {
    const wrong = await sweep({ "x-api-key": "crowd_not-a-real-key" });
    expect(wrong.statusCode).toBe(401);

    const viewer = await sweep({ "x-api-key": viewerKey });
    expect(viewer.statusCode).toBe(403);
  });

  it("200s the sweep for an admin key", async () => {
    const res = await sweep({ authorization: `Bearer ${adminKey}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ archived: 0 });
  });
});
