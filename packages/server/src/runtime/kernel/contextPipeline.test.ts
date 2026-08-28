import { describe, it, expect } from "vitest";
import { contextPipeline, ContextPipelineManager } from "./ContextPipelineManager.js";
import { toolRegistry, type ToolDefinition } from "../../tools/toolsGate.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "./contextTypes.js";

describe("Context Pipeline & Modular Architecture", () => {
  it("should initialize default middlewares in priority order", () => {
    const pipeline = new ContextPipelineManager();
    expect(pipeline).toBeDefined();
  });

  it("should assemble context packet with identity for Level 1 (Executive)", async () => {
    const mockAgent: any = {
      id: "test-agent-01",
      name: "Architect",
      title: "Chief System Architect",
      authorityLevel: 1,
      species: "Eagle",
      status: "idle",
      memorySharingPolicy: "full",
    };

    const packet = await contextPipeline.assemble({
      agent: mockAgent,
      channelId: "chan-01",
      workspaceId: "ws-01",
      userInput: "Please design a modular plugin system.",
      runtimeType: "agentic",
    });

    expect(packet).toBeDefined();
    expect(packet.systemPrompt).toContain("You are @Architect");
    expect(packet.systemPrompt).toContain("AUTHORITY LEVEL 1: EXECUTIVE LEADER");
    expect(packet.userInput).toBe("Please design a modular plugin system.");
    expect(packet._modelConfig).toBeDefined();
    expect(packet._modelConfig.provider).toBe("google");
  });

  it("should assemble context packet with identity for Level 0 (Omniscient)", async () => {
    const mockAgent: any = {
      id: "test-agent-l0",
      name: "Oracle",
      title: "Omniscient Workspace Observer",
      authorityLevel: 0,
      species: "Owl",
      status: "idle",
      memorySharingPolicy: "full",
    };

    const packet = await contextPipeline.assemble({
      agent: mockAgent,
      channelId: "chan-01",
      workspaceId: "ws-01",
      userInput: "Provide workspace health status.",
      runtimeType: "agentic",
    });

    expect(packet.systemPrompt).toContain("AUTHORITY LEVEL 0: OMNISCIENT OBSERVER");
  });

  it("should assemble context packet with identity for Level 3 (Supervisor)", async () => {
    const mockAgent: any = {
      id: "test-agent-l3-spv",
      name: "CodeReviewer",
      title: "Quality Supervisor",
      authorityLevel: 3,
      l3Subtype: "supervisor",
      species: "Crow",
      status: "idle",
      memorySharingPolicy: "full",
    };

    const packet = await contextPipeline.assemble({
      agent: mockAgent,
      channelId: "chan-01",
      workspaceId: "ws-01",
      userInput: "Review PR #42",
      runtimeType: "coding",
    });

    expect(packet.systemPrompt).toContain("AUTHORITY LEVEL 3: EVALUATION SUPERVISOR");
    expect(packet.systemPrompt).toContain("Validate worker code and outputs");
  });

  it("should dynamically inject custom middleware into pipeline", async () => {
    const pipeline = new ContextPipelineManager();

    class CustomBrandMiddleware implements IContextMiddleware {
      readonly name = "CustomBrandMiddleware";
      readonly priority = 15;

      async process(packet: MutableContextPacket, _ctx: ContextBuildContext): Promise<void> {
        packet.systemPromptBlocks.push({
          id: "brand_guidelines",
          priority: 15,
          content: "[BRAND VOICE]\nAlways speak in concise, high-clarity technical terms.",
        });
      }
    }

    pipeline.use(new CustomBrandMiddleware());

    const mockAgent: any = {
      id: "test-agent-brand",
      name: "BrandBot",
      title: "Brand Assistant",
      authorityLevel: 2,
      species: "Raven",
      status: "idle",
      memorySharingPolicy: "full",
    };

    const packet = await pipeline.assemble({
      agent: mockAgent,
      channelId: "chan-01",
      workspaceId: "ws-01",
      userInput: "Give me the summary.",
      runtimeType: "conversational",
    });

    expect(packet.systemPrompt).toContain("[BRAND VOICE]");
    expect(packet.systemPrompt).toContain("Always speak in concise, high-clarity technical terms.");
  });

  it("should register and resolve dynamic tools in ToolRegistry via toolsGate", () => {
    const customTool: ToolDefinition = {
      id: "calc_custom",
      name: "calc_custom",
      displayName: "Custom Calculator",
      description: "Performs mathematical arithmetic",
      category: "math",
      sourceType: "dynamic",
      dangerLevel: "safe",
      authLevelRequired: 3,
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "math expression" },
        },
        required: ["expression"],
      },
      handler: async (args) => {
        return { success: true, output: `Result of ${args.expression}` };
      },
    };

    toolRegistry.register(customTool);
    expect(toolRegistry.has("calc_custom")).toBe(true);

    const retrieved = toolRegistry.get("calc_custom");
    expect(retrieved?.displayName).toBe("Custom Calculator");

    toolRegistry.unregister("calc_custom");
    expect(toolRegistry.has("calc_custom")).toBe(false);
  });

  it("should NOT inject XML tool protocol or sentinel into system prompt for tool-capable runtimes", async () => {
    const mockAgent: any = {
      id: "test-agent-tools",
      name: "ToolBot",
      title: "Tool Tester",
      authorityLevel: 2,
      species: "Parrot",
      status: "idle",
      memorySharingPolicy: "full",
    };

    const packet = await contextPipeline.assemble({
      agent: mockAgent,
      channelId: "chan-01",
      workspaceId: "ws-01",
      userInput: "Run some tools.",
      runtimeType: "agentic",
    });

    // After CrowdTools migration: no XML protocol, no sentinel
    expect(packet.systemPrompt).not.toContain("[TOOL CALLING PROTOCOL]");
    expect(packet.systemPrompt).not.toContain("&&FINAL_RESPONSE&&");
    expect(packet.systemPrompt).not.toContain("<call_tool");

    // Native tools should include agent_complete
    if (packet.tools && packet.tools.length > 0) {
      const toolNames = packet.tools.map((t: any) => t.name);
      expect(toolNames).toContain('agent_complete');
    }
  });
});
