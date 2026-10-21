import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerRoutes } from "./index.js";
import { validatorCompiler } from "../shared/core/validation.js";

// Regression guard: route modules that exist but are never registered 404 in
// production while their own integration tests keep passing, because those
// tests wire a private app. This pins every documented mount endpoint onto the
// REAL registration entrypoint, so deleting a registration line fails here.
describe("registerRoutes", () => {
  it("serves every ChannelMounts endpoint", async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await registerRoutes(app);
    await app.ready();

    // The gate resolver answers "none" for unknown ids instead of throwing,
    // so a wired GET answers 200 with a { source: "none" } body — the same
    // 200 a wired route gives for any id. A 404 means the module is missing
    // from routes/index.ts.
    for (const url of [
      "/api/channels/no-such-channel/mount",
      "/api/categories/no-such-category/mount",
      "/api/workspaces/no-such-workspace/mount",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toMatchObject({ source: "none" });
    }

    // Browse with no path resolves inside the default jail; any status other
    // than 404 means the route module is registered (a 400 is browse's own
    // "Path does not exist" mapping, which is fine for presence).
    const browse = await app.inject({ method: "GET", url: "/api/fs/browse" });
    expect(browse.statusCode).not.toBe(404);

    const roots = await app.inject({ method: "GET", url: "/api/fs/allowed-roots" });
    expect(roots.statusCode).toBe(200);
    expect(Array.isArray(roots.json().roots)).toBe(true);

    await app.close();
  });

  // THR-001: threadRoutes must stay mounted on the real entrypoint.
  // Presence is asserted on the ROUTER, not on a probe request: the handlers
  // legitimately answer 404 for unknown ids (POST-create against a missing
  // channel answers 404 from the handler, routes/threads.ts), so a status
  // probe cannot tell "mounted" from "mounted and correctly 404".
  it("serves every Threads endpoint (THR-001)", async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await registerRoutes(app);
    await app.ready();

    // Every route declared in src/routes/threads.ts.
    const routes: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string }> = [
      { method: "GET", url: "/api/channels/:channelId/threads" },
      { method: "POST", url: "/api/channels/:channelId/threads" },
      { method: "GET", url: "/api/threads/:threadId" },
      { method: "PATCH", url: "/api/threads/:threadId" },
      { method: "DELETE", url: "/api/threads/:threadId" },
      { method: "GET", url: "/api/threads/:threadId/messages" },
      { method: "POST", url: "/api/threads/:threadId/messages" },
      { method: "POST", url: "/api/threads/sweep" },
    ];
    for (const { method, url } of routes) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }

    // Control: the mounted-check must be able to say "no", otherwise the
    // assertions above would pass with the module unregistered.
    expect(
      app.hasRoute({ method: "POST", url: "/api/channels/:channelId/threads-not-a-route" }),
    ).toBe(false);
    // The method is part of the check: the sweep is POST-only.
    expect(app.hasRoute({ method: "DELETE", url: "/api/threads/sweep" })).toBe(false);

    // A wired request still reaches the handler (list answers the documented
    // shape, sweep answers an archived count) — a router entry alone does not
    // prove the handler runs.
    const list = await app.inject({ method: "GET", url: "/api/channels/no-such-channel/threads" });
    expect(list.statusCode).not.toBe(404);
    expect(Array.isArray(list.json().threads)).toBe(true);

    const sweep = await app.inject({ method: "POST", url: "/api/threads/sweep", payload: {} });
    expect(sweep.statusCode).not.toBe(404);
    expect(typeof sweep.json().archived).toBe("number");

    await app.close();
  });

  // B3: the operator live-view routes must stay mounted on the real
  // entrypoint. A closed state read answers 200 without launching a browser;
  // a 404 means routes/browser.ts is missing from routes/index.ts.
  it("serves the Browser live-view state probe", async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await registerRoutes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/browser/state" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open: false, url: null, title: null });

    await app.close();
  });
});
