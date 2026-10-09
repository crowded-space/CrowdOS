// ART-4 regression guard (fix-artifacts-micro-4-5).
// GET /api/artifacts?workspaceId=<other> from a scoped caller must answer 403
// and must never reach the gate -- otherwise shared-DB deployments enumerate
// another workspace's artifacts. Hermetic: the gate is mocked, no DB needed.
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listByWorkspace: vi.fn(async (_ws: string, _opts?: unknown) => [] as unknown[]),
  listByRun: vi.fn(async (_id: string, _opts?: unknown) => [] as unknown[]),
  getById: vi.fn(async (_id: string) => null as unknown),
}));

vi.mock("./artifacts-gate.js", () => ({
  artifactsGate: {
    listByWorkspace: h.listByWorkspace,
    listByRun: h.listByRun,
    getById: h.getById,
  },
}));

import { validatorCompiler } from "../shared/core/validation.js";
import { artifactsRoutes } from "../routes/artifacts.js";

const openApps: Array<{ close: () => Promise<void> }> = [];

async function makeApp(callerWorkspaceId: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  // Mirrors the real tenant hook: scope the request to its workspace.
  app.addHook("onRequest", async (request) => {
    (request as any).workspaceId = callerWorkspaceId;
  });
  await artifactsRoutes(app);
  await app.ready();
  openApps.push(app);
  return app;
}

afterEach(async () => {
  h.listByWorkspace.mockClear();
  h.listByRun.mockClear();
  while (openApps.length > 0) await openApps.pop()!.close();
});

describe("artifacts route - ART-4 workspace binding", () => {
  it("rejects a caller/query workspaceId mismatch with 403 and never lists", async () => {
    const app = await makeApp("ws-A");
    const res = await app.inject({ method: "GET", url: "/api/artifacts?workspaceId=ws-B" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Forbidden" });
    expect(h.listByWorkspace).not.toHaveBeenCalled();
    expect(h.listByRun).not.toHaveBeenCalled();
  });

  it("lists when the query workspaceId matches the caller", async () => {
    h.listByWorkspace.mockResolvedValueOnce([{ id: "art_1" }]);
    const app = await makeApp("ws-A");
    const res = await app.inject({ method: "GET", url: "/api/artifacts?workspaceId=ws-A" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ artifacts: [{ id: "art_1" }] });
    expect(h.listByWorkspace.mock.calls[0]?.[0]).toBe("ws-A");
  });
});
