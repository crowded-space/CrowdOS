// Studio runtime-override routes: the write path for the local tier. An
// operator patches an agent's operating instructions at runtime; the
// instruction-stack middleware then applies the patch to the prompt.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { validatorCompiler } from "../shared/core/validation.js";
import { agentGate } from "../agents/agent-gate.js";
import { contextPipeline } from "../runtime/context-gate.js";
import { studioRoutes } from "./studio.js";

const WS = "ws-studio-overrides";

let app: FastifyInstance;
let dir: string;
let agentId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-studio-overrides-"));
  setLocalStoreDirForTests(dir);

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  // The tenant header resolution the real app does in an onRequest hook.
  app.addHook("onRequest", async (request) => {
    (request as any).workspaceId = WS;
  });
  await app.register(studioRoutes);
  await app.ready();

  const created = await agentGate.create({
    workspaceId: WS,
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
    modelModuleId: null,
    instructionModuleId: "instr-default",
    memorySharingPolicy: "vertical",
  });
  agentId = created.id;
});

afterEach(async () => {
  await app.close();
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function agentPrompt(): Promise<string> {
  const agent = await agentGate.getById(agentId, undefined, WS);
  const packet = await contextPipeline.assemble({
    agent: agent as any,
    channelId: "ch-studio",
    workspaceId: WS,
    userInput: "hi",
    runtimeType: "agentic",
    modelConfig: { provider: "custom", modelName: "studio-test-model" },
  });
  return packet.systemPrompt;
}

describe("PUT /api/studio/agents/:id/runtime-overrides", () => {
  it("stores the override and the agent's prompt reflects it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { instructionPatch: { append: ["OPERATOR PATCH"] } },
    });

    expect(res.statusCode).toBe(200);
    const row = res.json();
    expect(row).toMatchObject({
      targetAgentId: agentId,
      overrideType: "runtime_patch",
      instructionPatch: { append: ["OPERATOR PATCH"] },
    });
    expect(typeof row.id).toBe("string");

    // The override is in the local store ...
    const stored = await agentGate.listLocalRuntimeOverrides(agentId, WS);
    expect(stored).toEqual([row]);

    // ... and the agent's prompt carries it.
    const prompt = await agentPrompt();
    expect(prompt).toContain("[OPERATING INSTRUCTIONS]");
    expect(prompt).toContain("OPERATOR PATCH");
  });

  it("replaces the row when the same id is written again", async () => {
    const first = await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { instructionPatch: { append: ["FIRST"] } },
    });
    const id = first.json().id;

    const second = await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { id, instructionPatch: { append: ["SECOND"] } },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(id);
    const stored = await agentGate.listLocalRuntimeOverrides(agentId, WS);
    expect(stored).toHaveLength(1);
    expect(stored[0].instructionPatch).toEqual({ append: ["SECOND"] });
  });

  it("rejects an unparseable expiry", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { expiresAt: "not-a-date", instructionPatch: { append: ["X"] } },
    });

    expect(res.statusCode).toBe(400);
    expect(await agentGate.listLocalRuntimeOverrides(agentId, WS)).toEqual([]);
  });

  it("404s for an unknown agent", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/studio/agents/no-such-agent/runtime-overrides",
      payload: { instructionPatch: { append: ["X"] } },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404, message: "Agent not found" });
  });

  it("refuses the write while a database is configured (the PG branch owns the rows)", async () => {
    const { env } = await import("../shared/config/env.js");
    const previous = env.DATABASE_URL;
    env.DATABASE_URL = "postgres://crowdos:crowdos@127.0.0.1:5432/crowdos";
    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/studio/agents/${agentId}/runtime-overrides`,
        payload: { instructionPatch: { append: ["X"] } },
      });

      expect(res.statusCode).toBe(409);
      // No unread row was stored.
      expect(await agentGate.listLocalRuntimeOverrides(agentId, WS)).toEqual([]);
    } finally {
      env.DATABASE_URL = previous;
    }
  });
});

describe("GET /api/studio/agents/:id/runtime-overrides", () => {
  it("lists the agent's overrides", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { instructionPatch: { append: ["LISTED"] } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.overrides)).toBe(true);
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]).toMatchObject({
      targetAgentId: agentId,
      instructionPatch: { append: ["LISTED"] },
    });
  });

  it("404s for an unknown agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/studio/agents/no-such-agent/runtime-overrides",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/studio/agents/:id/runtime-overrides/:overrideId", () => {
  it("removes the override", async () => {
    const created = await app.inject({
      method: "PUT",
      url: `/api/studio/agents/${agentId}/runtime-overrides`,
      payload: { instructionPatch: { append: ["REMOVED"] } },
    });
    const id = created.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/studio/agents/${agentId}/runtime-overrides/${id}`,
    });
    expect(del.statusCode).toBe(204);

    expect(await agentGate.listLocalRuntimeOverrides(agentId, WS)).toEqual([]);
    const prompt = await agentPrompt();
    expect(prompt).not.toContain("REMOVED");
  });

  it("404s for an unknown override id and for an unknown agent", async () => {
    const unknownOverride = await app.inject({
      method: "DELETE",
      url: `/api/studio/agents/${agentId}/runtime-overrides/rov-does-not-exist`,
    });
    expect(unknownOverride.statusCode).toBe(404);

    const unknownAgent = await app.inject({
      method: "DELETE",
      url: "/api/studio/agents/no-such-agent/runtime-overrides/rov-anything",
    });
    expect(unknownAgent.statusCode).toBe(404);
  });
});
