import { describe, it, expect, vi } from "vitest";

/**
 * Integration seam: a persisted Model Module row (api_endpoint, thinking_level)
 * must ride through model-module resolution into the packet's `_modelConfig`,
 * since that is the single object every runtime hands to the provider adapter.
 *
 * HERE: the row is fetched through the Modules gate (workspace-scoped, DB-
 * backed in production) and assembled into `_modelConfig`. A missing field or
 * a non-scoped lookup would silently fall back to a default provider call —
 * the "cosmetic select that does nothing" failure this feature must not have.
 */
vi.mock("../../modules/module-gate.js", () => ({
  modelGateRef: vi.fn(),
  moduleGate: {
    model: {
      get: vi.fn().mockImplementation(async (id: string, workspaceId: string) => {
        if (id === "mod-responses") {
          return {
            id: "mod-responses",
            workspaceId: "ws-live",
            provider: "openai",
            modelName: "gpt-5.2",
            endpointUrl: null,
            apiKey: null,
            temperature: 0.7,
            maxOutputTokens: 2048,
            topP: null,
            apiEndpoint: "openai-responses",
            thinkingLevel: "high",
          };
        }
        return null;
      }),
    },
  },
}));

import { contextPipeline } from "./context-pipeline-manager.js";

describe("context pipeline — Model Module apiEndpoint + thinkingLevel ride-through", () => {
  it("forwards a bound module's apiEndpoint and thinkingLevel into the resolved model config", async () => {
    const packet = await contextPipeline.assemble({
      agent: {
        id: "agent-live-01",
        name: "Runner",
        title: "",
        authorityLevel: 2,
        species: "hound",
        status: "idle",
        memorySharingPolicy: "full",
        modelModuleId: "mod-responses",
      } as never,
      channelId: "chan-live-01",
      workspaceId: "ws-live",
      userInput: "say hi",
      runtimeType: "agentic",
    });

    expect(packet._modelConfig).toMatchObject({
      provider: "openai",
      modelName: "gpt-5.2",
      apiEndpoint: "openai-responses",
      thinkingLevel: "high",
    });
  });

  it(
    "resolves the module through the workspace-scoped gate lookup",
    async () => {
      const { moduleGate } = await import("../../modules/module-gate.js");
      await contextPipeline.assemble({
        agent: {
          id: "agent-live-02",
          name: "Runner2",
          title: "",
          authorityLevel: 2,
          species: "hound",
          status: "idle",
          memorySharingPolicy: "full",
          modelModuleId: "mod-responses",
        } as never,
        channelId: "chan-live-02",
        workspaceId: "ws-live",
        userInput: "say hi",
        runtimeType: "agentic",
      });

      const get = moduleGate.model.get as unknown as ReturnType<typeof vi.fn>;
      expect(get).toHaveBeenCalledWith("mod-responses", "ws-live");
    },
  );

  it("hides callers from a module that belongs to another workspace", async () => {
    await contextPipeline
      .assemble({
        agent: {
          id: "agent-live-03",
          name: "Runner3",
          title: "",
          authorityLevel: 2,
          species: "hound",
          status: "idle",
          memorySharingPolicy: "full",
          modelModuleId: "mod-other-ws",
        } as never,
        channelId: "chan-live-03",
        workspaceId: "ws-live",
        userInput: "say hi",
        runtimeType: "agentic",
      })
      .then(
        () => {
          throw new Error("expected MODEL_MODULE_NOT_CONFIGURED");
        },
        (err: { code?: string }) => {
          expect(err.code).toBe("MODEL_MODULE_NOT_CONFIGURED");
        },
      );
  });
});
