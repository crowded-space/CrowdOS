import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgenticRuntime } from "./AgenticRuntime.js";
import { RuntimeKernel } from "../kernel/RuntimeKernel.js";
import { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { EventBroker } from "../../EventBroker/eventBrokerGate.js";

vi.mock("../../tools/toolsGate.js", async () => {
  const actual = await vi.importActual("../../tools/toolsGate.js") as any;
  return actual;
});

describe("RES-1 AgenticRuntime resume dedupe", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips already-completed toolCalls and executes only remaining", async () => {
    const executed: string[] = [];
    const mockExecuteBatch = vi.fn(async (_agentId: string, calls: Array<{ toolId: string; args: Record<string, unknown> }>) => {
      for (const c of calls) executed.push(c.toolId);
      return calls.map(() => ({ success: true, output: `out ${Date.now()}`, durationMs: 1 }));
    });

    const { toolsGate } = await import("../../tools/toolsGate.js");
    vi.spyOn(toolsGate, "executeBatch").mockImplementation(mockExecuteBatch as never);

    const toolCalls = [
      { id: "call-1", name: "write_file", input: { path: "/tmp/a.txt", content: "a" } },
      { id: "call-2", name: "write_file", input: { path: "/tmp/b.txt", content: "b" } },
      { id: "call-3", name: "write_file", input: { path: "/tmp/c.txt", content: "c" } },
      { id: "call-4", name: "write_file", input: { path: "/tmp/d.txt", content: "d" } },
    ];

    let llmInvocations = 0;
    const adapter = {
      provider: "test-resume",
      supportsStreaming: false,
      supportsTools: true,
      async call(_config: unknown, _req: unknown) {
        llmInvocations++;
        if (llmInvocations === 1) {
          return {
            content: "step 1",
            thoughts: undefined,
            toolCalls,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: "tool_use" as const,
          };
        }
        return {
          content: "done",
          thoughts: undefined,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop" as const,
        };
      },
    };
    ProviderRegistry.register(adapter as never);

    // stub kernel persist and status to avoid DB
    const kernel = new RuntimeKernel();
    vi.spyOn(kernel as any, "setAgentStatus").mockResolvedValue(undefined);
    vi.spyOn(kernel as any, "persistMessage").mockResolvedValue(1);
    vi.spyOn(kernel as any, "emitThinking").mockImplementation(() => {});
    const broker = new EventBroker();

    const runtime = new AgenticRuntime();
    // @ts-ignore inject our mocked kernel
    (runtime as unknown as { kernel: RuntimeKernel }).kernel = kernel;

    const packet: any = {
      requestId: "req-resume",
      agentId: "agent-test",
      agentName: "TestAgent",
      authorityLevel: 3,
      channelId: "ch-resume",
      workspaceId: "default",
      userInput: "do 4 writes",
      systemPrompt: "sys",
      history: [],
      tools: [],
      policies: { maxTokenBudget: 10000, maxIterations: 5, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: false, streamOutput: false },
      metadata: { runtimeType: "agentic", provider: "test-resume", modelName: "test", modelModuleId: "m1", startedAt: new Date() },
      runId: "run-resume-id",
      resumeContext: { watermarkSeq: 2, completedCallIds: ["call-1", "call-2"], updatedAt: new Date().toISOString() },
    };

    const result = await runtime.execute(packet, broker);

    expect(result.status).toBe("completed");
    // only call-3 and call-4 should have been executed (skipped 1,2)
    expect(executed).toEqual(["write_file", "write_file"]);
    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    const calledIds = (mockExecuteBatch.mock.calls[0][1] as Array<{ toolId: string }>).map(c => c.toolId);
    expect(calledIds).toEqual(["write_file", "write_file"]);
    // verify that skipped calls were synthesized and still counted in toolCalls records?
    expect(result.toolCalls?.length).toBe(4);
    const names = result.toolCalls?.map(r => r.toolName);
    expect(names).toEqual(["write_file", "write_file", "write_file", "write_file"]);
    // Ensure that already-completed calls are marked as success synthesized
    expect(result.toolCalls?.[0].output).toContain("previously completed");
    expect(result.toolCalls?.[2].output).not.toContain("previously completed");

    ProviderRegistry.register = ProviderRegistry.register.bind(ProviderRegistry);
  });

  it("without resumeContext executes all tools", async () => {
    const executed: string[] = [];
    const mockExecuteBatch = vi.fn(async (_agentId: string, calls: Array<{ toolId: string; args: Record<string, unknown> }>) => {
      for (const c of calls) executed.push(c.toolId + ":" + JSON.stringify(c.args));
      return calls.map(() => ({ success: true, output: "ok", durationMs: 1 }));
    });
    const { toolsGate } = await import("../../tools/toolsGate.js");
    vi.spyOn(toolsGate, "executeBatch").mockImplementation(mockExecuteBatch as never);

    const toolCalls = [
      { id: "call-a", name: "read_file", input: { path: "/tmp/x" } },
      { id: "call-b", name: "read_file", input: { path: "/tmp/y" } },
    ];
    const adapter = {
      provider: "test-resume2",
      supportsStreaming: false,
      supportsTools: true,
      async call(_config: unknown, _req: unknown, _onChunk?: unknown, _opts?: unknown) {
        const count = (adapter as any)._count = ((adapter as any)._count || 0) + 1;
        if (count === 1) {
          return { content: "step", thoughts: undefined, toolCalls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_use" as const };
        }
        return { content: "done", thoughts: undefined, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" as const };
      },
    };
    ProviderRegistry.register(adapter as never);
    const kernel = new RuntimeKernel();
    vi.spyOn(kernel as any, "setAgentStatus").mockResolvedValue(undefined);
    vi.spyOn(kernel as any, "persistMessage").mockResolvedValue(1);
    vi.spyOn(kernel as any, "emitThinking").mockImplementation(() => {});
    const broker = new EventBroker();
    const runtime = new AgenticRuntime();
    (runtime as unknown as { kernel: RuntimeKernel }).kernel = kernel;
    const packet: any = {
      requestId: "req2",
      agentId: "agent-test",
      agentName: "TestAgent",
      authorityLevel: 3,
      channelId: "ch2",
      workspaceId: "default",
      userInput: "hi",
      systemPrompt: "sys",
      history: [],
      tools: [],
      policies: { maxTokenBudget: 10000, maxIterations: 5, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: false, streamOutput: false },
      metadata: { runtimeType: "agentic", provider: "test-resume2", modelName: "test", modelModuleId: "m1", startedAt: new Date() },
      runId: "run2",
    };
    const result = await runtime.execute(packet, broker);
    expect(result.status).toBe("completed");
    expect(executed.length).toBe(2);
  });
});
