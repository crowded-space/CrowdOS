import { describe, it, expect } from "vitest";
import {
  accountPromptTokens,
  enforcePerIterationBudget,
  estimateToolSchemaTokens,
  resolveEffectiveContextCap,
  resolvePacketContextCap,
  trimHistoryToCap,
} from "./context-budget.js";
import type { ContextPacket, HistoryMessage } from "../types.js";

function msg(partial: Partial<HistoryMessage> & { content: string }): HistoryMessage {
  return { role: "user", timestamp: new Date(), ...partial } as HistoryMessage;
}

function basePacket(overrides: Partial<ContextPacket>): ContextPacket {
  return {
    requestId: "req-budget",
    agentId: "agent-1",
    agentName: "Budgeteer",
    authorityLevel: 3,
    channelId: "chan-1",
    workspaceId: "ws-1",
    userInput: "do the task",
    systemPrompt: "sys",
    history: [],
    policies: {
      maxTokenBudget: 8000,
      maxIterations: 10,
      allowToolCalls: true,
      allowSpawn: false,
      allowDelegation: false,
      loopDetection: true,
      streamOutput: false,
    },
    metadata: {
      runtimeType: "agentic",
      provider: "p",
      modelName: "m",
      modelModuleId: "mod",
      startedAt: new Date(),
    },
    ...overrides,
  } as ContextPacket;
}

describe("resolveEffectiveContextCap", () => {
  it("prefers agent cap over custom override over policy budget", () => {
    expect(resolveEffectiveContextCap({ agentContextTokenCap: 5000, customContextTokenCap: 6000, maxTokenBudget: 8000 })).toBe(5000);
    expect(resolveEffectiveContextCap({ customContextTokenCap: 6000, maxTokenBudget: 8000 })).toBe(6000);
    expect(resolveEffectiveContextCap({ maxTokenBudget: 8000 })).toBe(8000);
  });

  it("floors small caps at 1000 and returns null when nothing is set", () => {
    expect(resolveEffectiveContextCap({ maxTokenBudget: 10 })).toBe(1000);
    expect(resolveEffectiveContextCap({})).toBeNull();
  });
});

describe("estimateToolSchemaTokens", () => {
  it("counts serialized tool schemas", () => {
    const tools = [{ name: "t", description: "x".repeat(200), inputSchema: { type: "object" } }];
    expect(estimateToolSchemaTokens(tools)).toBeGreaterThan(0);
    expect(estimateToolSchemaTokens([])).toBe(0);
    expect(estimateToolSchemaTokens(undefined)).toBe(0);
  });
});

describe("accountPromptTokens", () => {
  it("mirrors RuntimeKernel preview prefixing exactly", () => {
    const preview = "P".repeat(40);
    const userInput = "U".repeat(36);
    const withPreview = accountPromptTokens({ systemPrompt: "", history: [], userPrompt: userInput, memoryPreviewBlock: preview });
    // preview(40) + "\n\n"(2) + user(36) = 78 chars -> ceil(78/4) = 20
    expect(withPreview.userPromptTokens).toBe(20);
    const withoutPreview = accountPromptTokens({ systemPrompt: "", history: [], userPrompt: userInput });
    expect(withoutPreview.userPromptTokens).toBe(9); // 36/4
  });

  it("includes tool schema tokens in the total", () => {
    const tools = [{ name: "t", description: "d".repeat(400), inputSchema: { type: "object" } }];
    const a = accountPromptTokens({ systemPrompt: "", history: [], userPrompt: "" });
    const b = accountPromptTokens({ systemPrompt: "", history: [], userPrompt: "", tools });
    expect(b.totalTokens - a.totalTokens).toBe(estimateToolSchemaTokens(tools));
  });
});

describe("trimHistoryToCap", () => {
  it("trims oldest OTHER entries first and keeps all SELF", () => {
    const history = [
      msg({ content: "o1".repeat(500), isSelf: false }),
      msg({ content: "s1".repeat(500), isSelf: true }),
      msg({ content: "o2".repeat(500), isSelf: false }),
      msg({ content: "s2".repeat(500), isSelf: true }),
    ];
    const fixed = 100;
    // total = fixed + 4*250 = 1100; cap 700 -> drop 400 -> drops o1,o2 (250 each)
    const result = trimHistoryToCap(history, { capTokens: 700, fixedTokens: fixed });
    expect(result.trimmed).toBe(true);
    expect(result.history.map((h) => h.content)).toEqual([history[1].content, history[3].content]);
    expect(result.removedCount).toBe(2);
  });

  it("falls back to oldest SELF only after OTHERs are gone, never dropping the last SELF turn", () => {
    const history = [
      msg({ content: "s-old".repeat(400), isSelf: true }),
      msg({ content: "s-last".repeat(400), isSelf: true }),
    ];
    // total = fixed 1000 + 2*600 = 2200; cap 650 -> drop s-old, keep s-last
    // even though the remaining total (1600) still exceeds the cap.
    const result = trimHistoryToCap(history, { capTokens: 650, fixedTokens: 1000 });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].content).toBe(history[1].content);
    expect(result.totalTokensAfter).toBe(1000 + Math.ceil(2400 / 4));
    expect(result.totalTokensAfter).toBeGreaterThan(650); // last self kept despite overflow
  });

  it("returns the same array reference untouched when within budget", () => {
    const history = [msg({ content: "a" }), msg({ content: "b", isSelf: true })];
    const result = trimHistoryToCap(history, { capTokens: 1000, fixedTokens: 10 });
    expect(result.trimmed).toBe(false);
    expect(result.history).toBe(history);
  });

  it("counts tool-result turns as non-self (trimmable before any SELF turn)", () => {
    const history = [
      msg({ role: "assistant", content: "self".repeat(300), isSelf: true }),
      msg({ role: "tool", content: "tool-out".repeat(300), toolCallId: "c1" }),
    ];
    const result = trimHistoryToCap(history, { capTokens: 400, fixedTokens: 0 });
    expect(result.history.map((h) => h.role)).toEqual(["assistant"]);
    expect(result.history[0].isSelf).toBe(true);
  });
});

describe("enforcePerIterationBudget", () => {
  it("drops the memory preview when asked and keeps it on iteration 1", () => {
    const packet = basePacket({
      memoryPreviewBlock: "PREVIEW-BLOCK",
      policies: { maxTokenBudget: 8000, maxIterations: 10, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: true, streamOutput: false },
    });
    const first = enforcePerIterationBudget(packet, { iterationIndex: 1 });
    expect(first.memoryPreviewBlock).toBe("PREVIEW-BLOCK");
    const later = enforcePerIterationBudget(packet, { dropMemoryPreview: true, iterationIndex: 2 });
    expect(later.memoryPreviewBlock).toBeUndefined();
    expect((later.metadata as unknown as Record<string, unknown>).perIterationBudget).toMatchObject({ memoryPreviewDropped: true });
  });

  it("is a no-op passthrough for under-cap packets", () => {
    const packet = basePacket({});
    expect(enforcePerIterationBudget(packet, { iterationIndex: 3 })).toBe(packet);
  });

  it("trims appended history against the clamped policy cap", () => {
    const packet = basePacket({
      policies: { maxTokenBudget: 1100, maxIterations: 10, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: true, streamOutput: false },
      history: [
        msg({ content: "x".repeat(2400), isSelf: false }),
        msg({ content: "y".repeat(2400), isSelf: false }),
        msg({ content: "z".repeat(400), isSelf: true }),
      ],
    });
    const result = enforcePerIterationBudget(packet, { iterationIndex: 5 });
    expect(result).not.toBe(packet);
    expect(result.history).toHaveLength(2);
    expect(result.history.some((h) => h.isSelf)).toBe(true);
  });
});
