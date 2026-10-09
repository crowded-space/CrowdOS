import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { validatorCompiler } from "../../../../packages/server/src/shared/core/validation.js";

const TEST_TIMEOUT = 60_000;

// Evidence probe for THR-001 (ledger): proves the threads HTTP surface is
// unreachable through the real registration entrypoint while the route module
// itself wires every endpoint when registered directly.
describe("threads route registration probe (read-only)", () => {
  it("registerRoutes does NOT mount any threads endpoint", { timeout: TEST_TIMEOUT }, async () => {
    const { registerRoutes } = await import("../../../../packages/server/src/routes/index.js");
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await registerRoutes(app);
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/api/channels/:channelId/threads" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/api/channels/:channelId/threads" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/api/threads/:threadId" })).toBe(false);
    expect(app.hasRoute({ method: "PATCH", url: "/api/threads/:threadId" })).toBe(false);
    expect(app.hasRoute({ method: "DELETE", url: "/api/threads/:threadId" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/api/threads/:threadId/messages" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/api/threads/:threadId/messages" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/api/threads/sweep" })).toBe(false);

    await app.close();
  });

  it("threadRoutes module itself mounts every documented endpoint", { timeout: TEST_TIMEOUT }, async () => {
    const { threadRoutes } = await import("../../../../packages/server/src/routes/threads.js");
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    await threadRoutes(app);
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/api/channels/:channelId/threads" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/channels/:channelId/threads" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/threads/:threadId" })).toBe(true);
    expect(app.hasRoute({ method: "PATCH", url: "/api/threads/:threadId" })).toBe(true);
    expect(app.hasRoute({ method: "DELETE", url: "/api/threads/:threadId" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/threads/:threadId/messages" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/threads/:threadId/messages" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/threads/sweep" })).toBe(true);

    await app.close();
  });
});
