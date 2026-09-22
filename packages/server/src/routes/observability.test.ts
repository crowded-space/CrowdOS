// Regression coverage for the telemetry 401/500 pair (Desktop DevTools report).
//
// Two defects were observed live in the Electron shell's DevTools console:
//   1. GET /api/observability/cost/dashboard → 401 "Screenlock is enabled…"
//      even while the ACTIVE workspace was unlocked, because the renderer sent
//      no x-workspace-id. Untargeted, the PIN gate asks "is a screenlock
//      configured in ANY workspace" — one locked sibling 401'd the read.
//   2. Once targeted, a local-tier workspace (no record databaseUrl) answered
//      500, because the ledger reads `token_usage_log` × `model_modules` through
//      an unguarded `getDb()`. "No database" is an EMPTY LEDGER, not a fault.
//
// These tests pin the boundary so neither regression can return silently.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

const prevWorkspaceDir = process.env.WORKSPACE_DIR;
const registryDir = mkdtempSync(join(tmpdir(), "crowdos-obs-route-"));
process.env.WORKSPACE_DIR = registryDir;

const LOCKED = "ws_locked";
const OPEN = "ws_open_local";
const DEAD_DB = "ws_dead_db";

let app: any;
let stop: () => Promise<void>;

async function inject(opts: { url: string; workspaceId?: string; pin?: string }) {
  const headers: Record<string, string> = {};
  if (opts.workspaceId) headers["x-workspace-id"] = opts.workspaceId;
  if (opts.pin) headers["x-pin"] = opts.pin;
  return app.inject({
    method: "GET",
    url: opts.url,
    headers,
    // Loopback peer: the embedded desktop backend's trust boundary. This keeps
    // the assertions about the PIN gate, not about API-key auth.
    remoteAddress: "127.0.0.1",
  });
}

beforeAll(async () => {
  const { hashScreenLockPin, invalidatePinCache } = await import("../shared/auth/pin-gate.js");
  const { saveWorkspaceRecord, setRegistryFilePathForTests } = await import("../workspace/workspace-registry.js");

  setRegistryFilePathForTests(join(registryDir, "workspaces.json"));
  const now = new Date().toISOString();

  // A locked workspace with a database, and an UNLOCKED, database-less sibling —
  // exactly the shape that produced the live 401 then 500.
  // The locked workspace's URL is unreachable on purpose: these tests assert the
  // PIN boundary, and routing its (irrelevant) ledger read through the outage
  // path keeps a real local Postgres — whose credentials this suite must not
  // guess — out of the assertions.
  await saveWorkspaceRecord({
    id: LOCKED,
    name: "Locked",
    icon: "x",
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:59999/nope",
    rootPath: join(registryDir, LOCKED),
    screenLockPinHash: hashScreenLockPin("1234"),
    createdAt: now,
    updatedAt: now,
  });
  await saveWorkspaceRecord({
    id: OPEN,
    name: "Open Local",
    icon: "x",
    databaseUrl: "",
    rootPath: join(registryDir, OPEN),
    screenLockPinHash: null,
    createdAt: now,
    updatedAt: now,
  });
  // A database-backed workspace whose database is unreachable: the outage path.
  // Port 59999 is reserved/closed, so the pool cannot connect.
  await saveWorkspaceRecord({
    id: DEAD_DB,
    name: "Dead DB",
    icon: "x",
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:59999/nope",
    rootPath: join(registryDir, DEAD_DB),
    screenLockPinHash: null,
    createdAt: now,
    updatedAt: now,
  });
  invalidatePinCache();

  const { buildServer } = await import("../create-app.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
}, 60_000);

afterAll(async () => {
  await stop?.();
  (env as any).DATABASE_URL = prevDatabaseUrl;
  if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = prevWorkspaceDir;
});

describe("observability cost reads · screenlock targeting", () => {
  it("serves the unlocked workspace even when a sibling workspace is locked", async () => {
    const res = await inject({ url: "/api/observability/cost/dashboard", workspaceId: OPEN });
    expect(res.statusCode).toBe(200);
  });

  it("still 401s an untargeted read while any workspace is locked", async () => {
    // Documents the global branch the renderer used to fall into: without a
    // workspace target the gate cannot know which lock applies, so it denies.
    const res = await inject({ url: "/api/observability/cost/dashboard" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: 401, error: "Unauthorized" });
  });

  it("still 401s the locked workspace without a PIN, and 200s it with one", async () => {
    const denied = await inject({ url: "/api/observability/cost/dashboard", workspaceId: LOCKED });
    expect(denied.statusCode).toBe(401);

    // A correct PIN clears the gate; the unreachable database then degrades to
    // the empty dashboard, so the caller gets data rather than an error.
    const allowed = await inject({ url: "/api/observability/cost/dashboard", workspaceId: LOCKED, pin: "1234" });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ totalTokens: 0, localMode: true });
  });
});

describe("observability cost reads · local-tier honesty", () => {
  it("degrades a database-less workspace to an empty dashboard, never a 500", async () => {
    const res = await inject({ url: "/api/observability/cost/dashboard", workspaceId: OPEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalTokens: 0, totalCostUsd: 0, totalRuns: 0, localMode: true });
  });

  it("degrades the ledger and verifier reads the same way", async () => {
    const ledger = await inject({ url: "/api/observability/cost/ledger", workspaceId: OPEN });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toMatchObject({ ledger: [], count: 0, localMode: true });

    const verify = await inject({ url: "/api/observability/cost/verify", workspaceId: OPEN });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ match: true, deltaPct: 0, localMode: true });
  });

  it("degrades an UNREACHABLE database to the empty dashboard instead of a 500", async () => {
    // The 30s poll must never 500: an outage is "no data", not a broken endpoint.
    const res = await inject({ url: "/api/observability/cost/dashboard", workspaceId: DEAD_DB });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalTokens: 0, totalCostUsd: 0, localMode: true });
  }, 30_000);
});
