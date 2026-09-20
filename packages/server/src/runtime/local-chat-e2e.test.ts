// C3 slice 2 end-to-end: a full assistant turn with no DATABASE_URL.
// Seeds file-backed category/channel/agent, runs the executor with a stubbed
// provider, and asserts the reply is persisted to the local message log.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// True no-DB simulation: unset the import-time env singleton so the REAL tier
// resolution (not a mock predicate) takes the local path. Restored afterwards.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { EventBroker } from "../event-broker/event-broker-gate.js";
import { channelGate } from "../channels/channel-gate.js";
import { messageGate } from "../messages/message-gate.js";
import { agentRegistry } from "../agents/agent-service.js";
import { localSeedDefaultAgent } from "../agents/agent-local-store.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { runtimeGate } from "./runtime-gate.js";
import type { LLMRequest, LLMResponse } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-localchat-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("C3 slice 2 · local chat turn (no DATABASE_URL)", () => {
  it("user message → conversational reply → persisted history, agent idle after", async () => {
    const cat = await channelGate.createCategory({
      name: "General", workspaceId: "ws-local", createdBy: "system", position: 0,
    });
    const created = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
      undefined,
      "ws-local",
    );
    const channelId = (created as any).channel.id;
    const agent = await localSeedDefaultAgent();
    const broker = new EventBroker();

    await messageGate.append({
      channelId, authorId: "user-1", authorName: "Tester", authorLevel: "stakeholder",
      authorType: "user", content: "hello local world",
    });

    ProviderRegistry.register({
      provider: "google",
      supportsStreaming: false,
      supportsTools: false,
      async call(_config, req: LLMRequest): Promise<LLMResponse> {
        return {
          content: `echo: ${req.userPrompt}`,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          finishReason: "stop",
        };
      },
    });

    const result = await runtimeGate.execute({
      agent, channelId, workspaceId: "ws-local", userInput: "hello local world",
      broker, explicitRuntime: "conversational",
    });

    expect(result.status).toBe("completed");
    expect(result.finalResponse).toContain("hello local world");

    const page = await messageGate.getChannelMessagesPage(channelId, { limit: 10 });
    const contents = page.messages.map((m: any) => String(m.content));
    expect(contents.some((c) => c.includes("hello local world"))).toBe(true);
    expect(contents.some((c) => c.includes("echo:"))).toBe(true);

    expect((await agentRegistry.getById(agent.id))?.status).toBe("idle");
  }, 30_000);
});
