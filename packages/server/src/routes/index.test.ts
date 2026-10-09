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
  // Every endpoint below must not 404. Auth/DB failures answer non-404
  // (401/500), which still proves the module is registered.
  it("serves every Threads endpoint (THR-001)", async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await registerRoutes(app);
    await app.ready();

    // Presence is proven by routes that do NOT 404 on missing resources:
    // list (empty array), create (400 validation, not 404), sweep (count).
    // Single-resource GET/PATCH/DELETE correctly 404 on unknown ids from
    // the handler, so they cannot distinguish mounted from unmounted.
    const urls: Array<{ method: "GET" | "POST"; url: string }> = [
      { method: "GET", url: "/api/channels/no-such-channel/threads" },
      { method: "POST", url: "/api/channels/no-such-channel/threads" },
      { method: "POST", url: "/api/threads/sweep" },
    ];
    for (const { method, url } of urls) {
      const res = await app.inject({
        method,
        url,
        payload: method === "POST" ? {} : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).not.toBe(404);
    }

    await app.close();
  });
});
