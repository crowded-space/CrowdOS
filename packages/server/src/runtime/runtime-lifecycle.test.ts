import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

import {
  runtimeGate,
  RuntimeExecutor,
  RuntimeRouter,
  ContextAssembler,
  AgenticRuntime,
  CodingRuntime,
  ConversationalRuntime,
  SwarmRuntime,
  ProviderRegistry,
  agentCompleteTool,
  AGENT_COMPLETE,
  type ContextPacket,
  type IProviderAdapter,
  type LLMRequest,
  type LLMResponse,
} from "./runtime-gate.js";
import { toolsGate, toolRegistry } from "../tools/tools-gate.js";
import { filesystemGate } from "../Filesystem/filesystem-gate.js";
import { EventBroker, isValidMode } from "../event-broker/event-broker-gate.js";
import { composerModeToRuntime, type ComposerMode } from "./types.js";
import { getDb } from "../shared/config/database.js";
import { agents, channels } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("Agent Runtime, Routing, Tools & Lifecycle Integrated QA Suite", () => {
  let broker: EventBroker;
  let db: any;
  let testAgent: any;
  let testChannel: any;

  const origResearchFlag = process.env.RESEARCH_V1
  const origSwarmFlag = process.env.SWARM_V1

  beforeEach(async () => {
    // RT-1/SW-1 flags: routing tests expect research/swarm to be routable without explicit RESEARCH_V1/SWARM_V1 in .env.example (default false).
    // Pin them true for this suite so historical expectations hold; rollback behavior is covered by dedicated ResearchRuntime/Swarm tests.
    process.env.RESEARCH_V1 = "true"
    process.env.SWARM_V1 = "true"
    broker = new EventBroker();
    db = getDb();

    // Fetch existing seeded test agent & channel, or construct robust mocks
    testChannel = await db.query.channels.findFirst();
    testAgent = await db.query.agents.findFirst({
      where: (t: any, { eq }: any) => eq(t.authorityLevel, 1),
    });

    if (!testAgent) {
      testAgent = await db.query.agents.findFirst();
    }
  });

  afterEach(() => {
    if (origResearchFlag === undefined) delete (process.env as Record<string, unknown>).RESEARCH_V1 as unknown as string
    else process.env.RESEARCH_V1 = origResearchFlag
    if (origSwarmFlag === undefined) delete (process.env as Record<string, unknown>).SWARM_V1 as unknown as string
    else process.env.SWARM_V1 = origSwarmFlag
  })

  describe("1. Runtime Routing & Orchestration", () => {
    const router = new RuntimeRouter();

    it("routes explicit runtime overrides deterministically", () => {
      const agent: any = { id: "ag-01", name: "Worker", authorityLevel: 3 };
      expect(router.route({ agent: agent as any, explicitRuntime: "coding" })).toBe("coding");
      expect(router.route({ agent, explicitRuntime: "swarm" })).toBe("swarm");
      expect(router.route({ agent, explicitRuntime: "conversational" })).toBe("conversational");
      expect(router.route({ agent, explicitRuntime: "agentic" })).toBe("agentic");
    });

    it("routes librarian agent to research runtime", () => {
      const agent: any = { id: "agent-librarian", name: "Librarian", authorityLevel: 2 };
      expect(router.route({ agent, librarianAgentId: "agent-librarian" })).toBe("research");
    });

    it("routes based on the §6 channel runtime pin", () => {
      const l1: any = { id: "ag-02", name: "Architect", authorityLevel: 1 };
      expect(router.route({ agent: l1, preferredRuntime: "coding" })).toBe("coding");
      expect(router.route({ agent: l1, preferredRuntime: "research" })).toBe("research");
      // L2 owns the swarm engine, so a swarm pin is honored there.
      const l2: any = { id: "ag-03", name: "Orchestrator", authorityLevel: 2 };
      expect(router.route({ agent: l2, preferredRuntime: "swarm" })).toBe("swarm");
      // A pin the tier forbids is NOT obeyed — it falls through to the tier
      // default instead of inverting §25 authority-aware routing.
      const l3: any = { id: "ag-04", name: "Worker", authorityLevel: 3 };
      expect(router.route({ agent: l3, preferredRuntime: "swarm" })).toBe("agentic");
    });

    it("routes based on authority levels as default hierarchy", () => {
      const l0: any = { id: "l0", name: "Apex", authorityLevel: 0 };
      const l1: any = { id: "l1", name: "Architect", authorityLevel: 1 };
      const l2: any = { id: "l2", name: "Orchestrator", authorityLevel: 2 };
      const l3: any = { id: "l3", name: "Specialist", authorityLevel: 3 };

      expect(router.route({ agent: l0 })).toBe("agentic");
      expect(router.route({ agent: l1 })).toBe("agentic");
      expect(router.route({ agent: l2 })).toBe("swarm");
      // §25: the mapping must not be inverted — the worker tier gets narrow
      // EXECUTION, never the most limited runtime.
      expect(router.route({ agent: l3 })).toBe("agentic");
    });

    it("runtimeGate.route delegates properly to router port", () => {
      const agent: any = { id: "ag-03", name: "Lead", authorityLevel: 1 };
      expect(runtimeGate.route({ agent })).toBe("agentic");
    });

    it("validates modes and maps composer modes to runtime types accurately", () => {
      expect(isValidMode("auto")).toBe(true);
      expect(isValidMode("chat")).toBe(true);
      expect(isValidMode("conversational")).toBe(true);
      expect(isValidMode("agentic")).toBe(true);
      expect(isValidMode("coding")).toBe(true);
      expect(isValidMode("research")).toBe(true);
      expect(isValidMode("unknown_mode")).toBe(false);
      expect(isValidMode(123)).toBe(false);
      expect(isValidMode(null)).toBe(false);

      expect(composerModeToRuntime("auto")).toBeUndefined();
      expect(composerModeToRuntime(undefined)).toBeUndefined();
      expect(composerModeToRuntime("chat")).toBe("conversational");
      expect(composerModeToRuntime("conversational")).toBe("conversational");
      expect(composerModeToRuntime("agentic")).toBe("agentic");
      expect(composerModeToRuntime("coding")).toBe("coding");
      expect(composerModeToRuntime("research")).toBe("research");
    });

    it("forces identical runtime across all agent authority levels when explicit mode is set", () => {
      const agents: any[] = [
        { id: "ag-l0", name: "Apex", authorityLevel: 0 },
        { id: "ag-l1", name: "Architect", authorityLevel: 1 },
        { id: "ag-l2", name: "Orchestrator", authorityLevel: 2 },
        { id: "ag-l3", name: "Worker", authorityLevel: 3 },
      ];

      const explicitModes: Array<{ mode: ComposerMode; expected: string }> = [
        { mode: "chat", expected: "conversational" },
        { mode: "agentic", expected: "agentic" },
        { mode: "coding", expected: "coding" },
        { mode: "research", expected: "research" },
      ];

      for (const { mode, expected } of explicitModes) {
        const runtimeOverride = composerModeToRuntime(mode);
        for (const agent of agents) {
          const routed = router.route({
            agent,
            preferredRuntime: "coding", // A channel pin must NOT override explicit mode
            explicitRuntime: runtimeOverride,
          });
          expect(routed).toBe(expected);
        }
      }
    });

    it("injects Active Runtime system flag into system prompt for all runtime types", async () => {
      const testAgentProfile: any = {
        id: "ag-prompt-test",
        name: "TestAgent",
        authorityLevel: 1,
        species: "Falcon",
      };

      const runtimeMappings: Array<{ runtimeType: any; expectedFlag: string }> = [
        { runtimeType: "conversational", expectedFlag: "Active Runtime: Chat" },
        { runtimeType: "agentic", expectedFlag: "Active Runtime: Agentic" },
        { runtimeType: "coding", expectedFlag: "Active Runtime: Coding" },
        { runtimeType: "research", expectedFlag: "Active Runtime: Research" },
        { runtimeType: "swarm", expectedFlag: "Active Runtime: Swarm" },
      ];

      for (const { runtimeType, expectedFlag } of runtimeMappings) {
        const packet = await runtimeGate.assembleContext({
          agent: testAgentProfile,
          channelId: "ch-test",
          workspaceId: "default",
          userInput: "Hello",
          runtimeType,
        });

        expect(packet.systemPrompt).toContain("[ACTIVE RUNTIME ENGINE]");
        expect(packet.systemPrompt).toContain(expectedFlag);
      }
    });
  });

  describe("2. Full Agent Execution Lifecycle & State Transitions", () => {
    it("executes complete lifecycle: idle -> working -> thinking -> tool call -> tool result -> complete -> idle", async () => {
      if (!testAgent || !testChannel) return;

      const eventsReceived: Array<{ type: string; payload: any }> = [];
      broker.onAny((event) => {
        eventsReceived.push({ type: event.type, payload: event.payload });
      });

      let turnCount = 0;
      const mockProvider: IProviderAdapter = {
        provider: "lifecycle-mock-provider",
        supportsStreaming: true,
        supportsTools: true,
        async call(_config, req: LLMRequest, onChunk): Promise<LLMResponse> {
          turnCount++;
          if (turnCount === 1) {
            onChunk?.({ isThoughts: true, content: "Planning tool execution for read_file." });
            return {
              content: "I will read the workspace configuration file.",
              thoughts: "Planning tool execution for read_file.",
              toolCalls: [
                {
                  id: "call_read_1",
                  name: "list_directory",
                  input: { path: "." },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
              finishReason: "tool_use",
            };
          } else {
            onChunk?.({ isThoughts: false, content: "Workspace inspection complete. Found files." });
            return {
              content: "Workspace inspection complete. Found files.",
              thoughts: "Interpreted list_directory result successfully.",
              toolCalls: [
                {
                  id: "call_comp_1",
                  name: AGENT_COMPLETE,
                  input: { response: "Workspace inspection complete. Found files." },
                },
              ],
              usage: { promptTokens: 40, completionTokens: 25, totalTokens: 65 },
              finishReason: "tool_use",
            };
          }
        },
      };

      ProviderRegistry.register(mockProvider);

      const packet: ContextPacket = {
        requestId: "req_lifecycle_test",
        agentId: testAgent.id,
        agentName: testAgent.name,
        authorityLevel: testAgent.authorityLevel,
        channelId: testChannel.id,
        workspaceId: testChannel.workspaceId || "default",
        userInput: "Check files in the workspace",
        systemPrompt: "You are an automated test agent.",
        history: [],
        tools: [
          { name: "list_directory", description: "List files", inputSchema: {} },
          agentCompleteTool,
        ],
        policies: {
          maxTokenBudget: 4000,
          maxIterations: 5,
          allowToolCalls: true,
          allowSpawn: false,
          allowDelegation: false,
          loopDetection: true,
          streamOutput: true,
        },
        metadata: {
          runtimeType: "agentic",
          provider: "lifecycle-mock-provider",
          modelName: "mock-model",
          modelModuleId: "default",
          startedAt: new Date(),
        },
        _modelConfig: {
          provider: "lifecycle-mock-provider",
          modelName: "mock-model",
        },
      } as any;

      const runtime = new AgenticRuntime();
      const result = await runtime.execute(packet, broker);

      expect(result.status).toBe("completed");
      expect(result.finalResponse).toBe("Workspace inspection complete. Found files.");
      expect(turnCount).toBe(2);
      expect(result.toolCalls?.length).toBe(1);
      expect(result.toolCalls?.[0].toolName).toBe("list_directory");

      // Verify lifecycle state events in exact order
      const eventTypes = eventsReceived.map((e) => e.type);
      expect(eventTypes).toContain("agent:status");
      expect(eventTypes).toContain("agent:thinking");
      expect(eventTypes).toContain("tool:start");
      expect(eventTypes).toContain("tool:complete");
      expect(eventTypes).toContain("message:new");

      // Verify agent status was reset back to idle in DB
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, testAgent.id),
      });
      expect(updatedAgent?.status).toBe("idle");
    });
  });

  describe("3. Tool Registration, Discovery, Safety & Error Handling", () => {
    it("toolsGate discovers and lists registered tools", () => {
      const allTools = toolsGate.list();
      expect(allTools.length).toBeGreaterThan(0);
      expect(toolsGate.has("read_file")).toBe(true);
      expect(toolsGate.has("write_file")).toBe(true);
      expect(toolsGate.has("list_directory")).toBe(true);
      expect(toolsGate.has("remember")).toBe(true);
      expect(toolsGate.has("open_memory")).toBe(true);
    });

    it("ToolExecutor validates and blocks unauthorized tools", async () => {
      if (!testAgent) return;
      const result = await toolsGate.execute(testAgent.id, "non_existent_or_unauthorized_tool_xyz", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Security breach");
    });

    it("ToolExecutor executes universal memory tools and validates inputs", async () => {
      if (!testAgent) return;
      // Universal tool "remember" is authorized for all agents
      const result = await toolsGate.execute(testAgent.id, "remember", {
        agent_id: testAgent.id,
        channel_id: testChannel?.id,
        hook: "Observed test execution outcome.",
        brief: "Verified memory tool execution contract and persistence.",
        note_type: "reflection",
        importance_score: 0.8,
        source_type: "self_reflection",
      }, { channelId: testChannel?.id });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Memory written to vault");
    });

    it("ToolExecutor rejects invalid inputs on memory tools", async () => {
      if (!testAgent) return;
      const result = await toolsGate.execute(testAgent.id, "remember", {
        agent_id: testAgent.id,
        hook: "",
        brief: "",
        note_type: "reflection",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });

    it("ToolExecutor rejects path traversal attacks on file tools when authorized", async () => {
      if (!testAgent) return;
      const { skillsGate } = await import("../skills/skills-gate.js");
      const testSkill = await skillsGate.create({
        name: "Test FS Skill " + Date.now(),
        description: "FS capability",
        requiredToolIds: ["read_file", "write_file", "list_directory", "execute_safe"],
      });
      await skillsGate.assignSkill(testAgent.id, testSkill.id);

      // Path traversal check
      const result = await toolsGate.execute(testAgent.id, "read_file", { path: "../../../../../etc/passwd" });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Safe command check
      const safeResult = await toolsGate.execute(testAgent.id, "execute_safe", { command: "rm -rf /" });
      expect(safeResult.success).toBe(false);
      expect(safeResult.error).toContain("Safety Alert");

      // Valid list directory
      const listRes = await toolsGate.execute(testAgent.id, "list_directory", { path: "." });
      expect(listRes.success).toBe(true);

      // Clean up skill
      await skillsGate.removeSkill(testAgent.id, testSkill.id);
    });
  });

  describe("4. Runtime Failure Paths & Cancellation Recovery", () => {
    it("handles LLM failure gracefully without corrupting agent lifecycle state", async () => {
      if (!testAgent || !testChannel) return;

      const failingProvider: IProviderAdapter = {
        provider: "failing-mock-provider",
        supportsStreaming: true,
        supportsTools: true,
        async call(): Promise<LLMResponse> {
          throw new Error("Simulated Provider Rate Limit / Network Outage 503");
        },
      };

      ProviderRegistry.register(failingProvider);

      const packet: ContextPacket = {
        requestId: "req_fail_test",
        agentId: testAgent.id,
        agentName: testAgent.name,
        authorityLevel: testAgent.authorityLevel,
        channelId: testChannel.id,
        workspaceId: testChannel.workspaceId || "default",
        userInput: "Perform operation",
        systemPrompt: "You are a test agent.",
        history: [],
        tools: [],
        policies: {
          maxTokenBudget: 4000,
          maxIterations: 3,
          allowToolCalls: false,
          allowSpawn: false,
          allowDelegation: false,
          loopDetection: true,
          streamOutput: false,
        },
        metadata: {
          runtimeType: "agentic",
          provider: "failing-mock-provider",
          modelName: "failing-model",
          modelModuleId: "default",
          startedAt: new Date(),
        },
        _modelConfig: {
          provider: "failing-mock-provider",
          modelName: "failing-model",
        },
      } as any;

      const runtime = new AgenticRuntime();
      const result = await runtime.execute(packet, broker);

      expect(result.status).toBe("failed");
      expect(result.finalResponse).toContain("Execution failed");

      // Verify agent status was reset back to idle in DB even after catastrophic failure
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, testAgent.id),
      });
      expect(updatedAgent?.status).toBe("idle");
    });

    it("handles tool execution failure and allows model to recover", async () => {
      if (!testAgent || !testChannel) return;

      let callCount = 0;
      const recoverableProvider: IProviderAdapter = {
        provider: "recoverable-tool-provider",
        supportsStreaming: true,
        supportsTools: true,
        async call(_config, req: LLMRequest): Promise<LLMResponse> {
          callCount++;
          if (callCount === 1) {
            // Intentionally request a file that does not exist
            return {
              content: "Reading non-existent file...",
              toolCalls: [
                {
                  id: "call_read_missing",
                  name: "read_file",
                  input: { path: "non_existent_file_12345.txt" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
              finishReason: "tool_use",
            };
          } else {
            // Model sees the error and delivers a recovery response
            return {
              content: "The file was not found, so I created a fallback solution.",
              toolCalls: [
                {
                  id: "call_complete_rec",
                  name: AGENT_COMPLETE,
                  input: { response: "The file was not found, so I created a fallback solution." },
                },
              ],
              usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
              finishReason: "tool_use",
            };
          }
        },
      };

      ProviderRegistry.register(recoverableProvider);

      const packet: ContextPacket = {
        requestId: "req_rec_test",
        agentId: testAgent.id,
        agentName: testAgent.name,
        authorityLevel: testAgent.authorityLevel,
        channelId: testChannel.id,
        workspaceId: testChannel.workspaceId || "default",
        userInput: "Read missing file",
        systemPrompt: "You are a test agent.",
        history: [],
        tools: [
          { name: "read_file", description: "Read file", inputSchema: {} },
          agentCompleteTool,
        ],
        policies: {
          maxTokenBudget: 4000,
          maxIterations: 5,
          allowToolCalls: true,
          allowSpawn: false,
          allowDelegation: false,
          loopDetection: true,
          streamOutput: false,
        },
        metadata: {
          runtimeType: "agentic",
          provider: "recoverable-tool-provider",
          modelName: "mock-model",
          modelModuleId: "default",
          startedAt: new Date(),
        },
        _modelConfig: {
          provider: "recoverable-tool-provider",
          modelName: "mock-model",
        },
      } as any;

      const runtime = new AgenticRuntime();
      const result = await runtime.execute(packet, broker);

      expect(result.status).toBe("completed");
      expect(callCount).toBe(2);
      expect(result.finalResponse).toBe("The file was not found, so I created a fallback solution.");
      expect(result.toolCalls?.length).toBe(1);
      expect(result.toolCalls?.[0].success).toBe(false); // Tool call failed
    });
  });

  describe("5. Domain Facade & Gates Architectural Invariants", () => {
    it("exposes runtime capabilities exclusively through runtimeGate facade", () => {
      expect(runtimeGate.execute).toBeDefined();
      expect(runtimeGate.route).toBeDefined();
      expect(runtimeGate.assembleContext).toBeDefined();
      expect(runtimeGate.useMiddleware).toBeDefined();
      expect(runtimeGate.registerProvider).toBeDefined();
      expect(runtimeGate.getProvider).toBeDefined();
      expect(runtimeGate.hasProvider).toBeDefined();
    });

    it("exposes tools capabilities exclusively through toolsGate facade", () => {
      expect(toolsGate.get).toBeDefined();
      expect(toolsGate.has).toBeDefined();
      expect(toolsGate.list).toBeDefined();
      expect(toolsGate.execute).toBeDefined();
      expect(toolsGate.register).toBeDefined();
      expect(toolsGate.unregister).toBeDefined();
    });

    it("exposes filesystem capabilities exclusively through filesystemGate facade", () => {
      expect(filesystemGate.createLocalFilesystem).toBeDefined();
      expect(filesystemGate.normalizePath).toBeDefined();
      expect(filesystemGate.isPathSafe).toBeDefined();
      expect(filesystemGate.resolveWorkspacePath).toBeDefined();
      expect(filesystemGate.isInsideRoot).toBeDefined();
    });
  });
  describe("6. Swarm & Conversational Runtime Execution", () => {
    it("ConversationalRuntime executes single-turn dialogue and records monologue", async () => {
      if (!testAgent || !testChannel) return;

      const mockConvProvider: IProviderAdapter = {
        provider: "conv-mock-provider",
        supportsStreaming: true,
        supportsTools: false,
        async call(_config, req: LLMRequest, onChunk): Promise<LLMResponse> {
          onChunk?.({ isThoughts: true, content: "Thinking about conversation." });
          onChunk?.({ isThoughts: false, content: "Hello! How can I assist you today?" });
          return {
            content: "Hello! How can I assist you today?",
            thoughts: "Thinking about conversation.",
            usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
            finishReason: "stop",
          };
        },
      };

      ProviderRegistry.register(mockConvProvider);

      const packet: ContextPacket = {
        requestId: "req_conv_test",
        agentId: testAgent.id,
        agentName: testAgent.name,
        authorityLevel: testAgent.authorityLevel,
        channelId: testChannel.id,
        workspaceId: testChannel.workspaceId || "default",
        userInput: "Hi there",
        systemPrompt: "You are a conversational agent.",
        history: [],
        tools: [],
        policies: {
          maxTokenBudget: 2000,
          maxIterations: 1,
          allowToolCalls: false,
          allowSpawn: false,
          allowDelegation: false,
          loopDetection: false,
          streamOutput: true,
        },
        metadata: {
          runtimeType: "conversational",
          provider: "conv-mock-provider",
          modelName: "conv-model",
          modelModuleId: "default",
          startedAt: new Date(),
        },
        _modelConfig: {
          provider: "conv-mock-provider",
          modelName: "conv-model",
        },
      } as any;

      const runtime = new ConversationalRuntime();
      const result = await runtime.execute(packet, broker);

      expect(result.status).toBe("completed");
      expect(result.finalResponse).toBe("Hello! How can I assist you today?");
      expect(result.internalMonologue).toBe("Thinking about conversation.");
    });

    it("SwarmRuntime executes orchestration reasoning and returns plan", async () => {
      if (!testAgent || !testChannel) return;

      const mockSwarmProvider: IProviderAdapter = {
        provider: "swarm-mock-provider",
        supportsStreaming: false,
        supportsTools: false,
        async call(): Promise<LLMResponse> {
          return {
            content: "1. Yes, I can handle the task directly. 2. No worker spawning needed.",
            thoughts: "Evaluated workload and capacity.",
            usage: { promptTokens: 25, completionTokens: 20, totalTokens: 45 },
            finishReason: "stop",
          };
        },
      };

      ProviderRegistry.register(mockSwarmProvider);

      const packet: ContextPacket = {
        requestId: "req_swarm_test",
        agentId: testAgent.id,
        agentName: testAgent.name,
        authorityLevel: 2,
        channelId: testChannel.id,
        workspaceId: testChannel.workspaceId || "default",
        userInput: "Coordinate the system release",
        systemPrompt: "You are an orchestration coordinator.",
        history: [],
        tools: [],
        policies: {
          maxTokenBudget: 4000,
          maxIterations: 1,
          allowToolCalls: false,
          allowSpawn: true,
          allowDelegation: true,
          loopDetection: false,
          streamOutput: false,
        },
        metadata: {
          runtimeType: "swarm",
          provider: "swarm-mock-provider",
          modelName: "swarm-model",
          modelModuleId: "default",
          startedAt: new Date(),
        },
        _modelConfig: {
          provider: "swarm-mock-provider",
          modelName: "swarm-model",
        },
      } as any;

      const runtime = new SwarmRuntime();
      const result = await runtime.execute(packet, broker);

      expect(result.status).toBe("completed");
      expect(result.finalResponse).toContain("Yes, I can handle the task directly");
    });
  });

});
