import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomAdapter } from "./custom-adapter.js";
import { GoogleAdapter } from "./google-adapter.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { OpenAIAdapter } from "./open-ai-adapter.js";
import { usesResponsesProtocol } from "./openai-responses.js";
import type { LLMRequest, ModelModuleConfig } from "../types.js";

const LLM_REQ: LLMRequest = { systemPrompt: "sys", userPrompt: "hello" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

/**
 * Captures the request URL/body and returns a canned response. Asserts on
 * adapter behavior through the public call() surface, per Domain testing rules.
 */
async function captureCall(
  adapter: { call: (...args: any[]) => Promise<unknown> },
  config: ModelModuleConfig,
  payload: unknown,
  req: LLMRequest = LLM_REQ,
): Promise<{ url: string; body: Record<string, unknown>; result: unknown }> {
  let url = "";
  let body = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body || "{}"));
      return stubJsonResponse(payload);
    }),
  );
  const result = await adapter.call(config, req);
  return { url, body, result };
}

const encoder = new TextEncoder();

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
}

// Non-empty responses payload; output: [] would hit the adapters' empty guard.
const rspOk = {
  output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

describe("ModelModule.apiEndpoint — responses protocol selection", () => {
  it("routes openai/custom + openai-responses to POST {base}/responses; everything else keeps chat/completions", async () => {
    // Each dialect gets its own payload: chat/completions parses choices[],
    // the responses protocol parses output[].
    const stub = vi.fn(async (u: unknown) => {
      if (String(u).includes("/chat/completions")) {
        return stubJsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} });
      }
      return stubJsonResponse(rspOk);
    });
    vi.stubGlobal("fetch", stub);

    const openai = new OpenAIAdapter();
    await openai.call({ provider: "openai", modelName: "gpt-5.2", apiKey: "k" }, LLM_REQ);
    expect(String(stub.mock.calls.at(-1)?.[0])).toContain("/chat/completions");

    await openai.call({ provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses" }, LLM_REQ);
    expect(String(stub.mock.calls.at(-1)?.[0])).toContain("/responses");

    const custom = new CustomAdapter();
    await custom.call({ provider: "custom", modelName: "llama", apiKey: "k", endpointUrl: "http://127.0.0.1:20128/v1", apiEndpoint: "openai-responses" }, LLM_REQ);
    expect(String(stub.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:20128/v1/responses");
  });

  it("usesResponsesProtocol matches the wire only for openai-responses", () => {
    expect(usesResponsesProtocol({})).toBe(false);
    expect(usesResponsesProtocol({ apiEndpoint: "openai-completion" })).toBe(false);
    expect(usesResponsesProtocol({ apiEndpoint: "openai-responses" })).toBe(true);
  });
});

describe("ModelModule.apiEndpoint — responses body mapping", () => {
  it("history → input items, system → instructions, tools → flat function defs", async () => {
    const req: LLMRequest = {
      systemPrompt: "be terse",
      userPrompt: "weather?",
      history: [
        { role: "assistant", content: "quick answer", timestamp: new Date(1), toolCalls: [{ id: "call_1", name: "get_weather", input: { city: "SF" } }] },
        { role: "tool", content: '{"t":20}', timestamp: new Date(2), toolCallId: "call_1" },
        { role: "user", content: "thanks", timestamp: new Date(3) },
      ],
      tools: [{ name: "get_weather", description: "weather getter", inputSchema: { type: "object" } }],
    };
    const { body } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses" },
      rspOk,
      req,
    );
    expect(body.instructions).toBe("be terse");
    expect(body.input).toEqual([
      { role: "assistant", content: "quick answer" },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"t":20}' },
      { role: "user", content: "thanks" },
      { role: "user", content: "weather?" },
    ]);
    expect(body.tools).toEqual([
      { type: "function", name: "get_weather", description: "weather getter", parameters: { type: "object" } },
    ]);
  });
});

describe("ModelModule.thinkingLevel — responses protocol", () => {
  it("maps to reasoning.effort and drops temperature while reading is on", async () => {
    const { body } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses", thinkingLevel: "xhigh", temperature: 0.3 },
      rspOk,
    );
    expect(body.reasoning).toEqual({ effort: "xhigh" });
    expect(body.temperature).toBeUndefined();
  });

  it("'none' means provider default: no reasoning knob, temperature kept", async () => {
    const { body } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses", thinkingLevel: "none", temperature: 0.3 },
      rspOk,
    );
    expect(body.reasoning).toBeUndefined();
    expect(body.temperature).toBe(0.3);
  });

  it("unset thinking omits the knob entirely (legacy rows unchanged)", async () => {
    const { body } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses" },
      rspOk,
    );
    expect("reasoning" in body).toBe(false);
  });
});

describe("ModelModule.thinkingLevel — chat/completions (openai/custom)", () => {
  it("passes the level through as reasoning_effort; 'none'/unset sends nothing", async () => {
    const { body } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", thinkingLevel: "medium" },
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} },
    );
    expect(body.reasoning_effort).toBe("medium");

    const none = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", thinkingLevel: "none" },
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} },
    );
    expect(none.body.reasoning_effort).toBeUndefined();
    expect("reasoning" in none.body).toBe(false);
  });
});

describe("ModelModule.thinkingLevel — google generationConfig", () => {
  it("maps to thinkingConfig.thinkingLevel; 'none' omits it", async () => {
    const { body } = await captureCall(
      new GoogleAdapter(),
      { provider: "google", modelName: "gemini-3-pro", apiKey: "k", thinkingLevel: "high" },
      { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: {} },
    );
    expect((body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "high" });

    const none = await captureCall(
      new GoogleAdapter(),
      { provider: "google", modelName: "gemini-3-pro", apiKey: "k", thinkingLevel: "none" },
      { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: {} },
    );
    expect((none.body.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();
  });
});

describe("ModelModule.thinkingLevel — anthropic budgets", () => {
  it("maps level → budget_tokens, drops temperature, and keeps max_tokens above the budget", async () => {
    const { body } = await captureCall(
      new AnthropicAdapter(),
      { provider: "anthropic", modelName: "claude-sonnet-4-5", apiKey: "k", thinkingLevel: "high", temperature: 0.4, maxOutputTokens: 3000 },
      { content: [{ type: "text", text: "ok" }], usage: {} },
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBe(8193);
    expect(body.temperature).toBeUndefined();
  });

  it("'none' sends no thinking block and keeps temperature/max_tokens", async () => {
    const { body } = await captureCall(
      new AnthropicAdapter(),
      { provider: "anthropic", modelName: "claude-sonnet-4-5", apiKey: "k", thinkingLevel: "none", temperature: 0.4, maxOutputTokens: 3000 },
      { content: [{ type: "text", text: "ok" }], usage: {} },
    );
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(3000);
  });
});

describe("OpenAI Responses — non-streaming parse", () => {
  it("message text + reasoning summary + function_call → content/thoughts/toolCalls/usage", async () => {
    const { result } = await captureCall(
      new OpenAIAdapter(),
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses" },
      {
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
          { type: "message", content: [{ type: "output_text", text: "Hello there" }] },
          { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"SF"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    ) as { result: { content: string; thoughts?: string; toolCalls?: ({ name: string; input: Record<string, unknown> } & { id?: string })[]; usage: { totalTokens: number }; finishReason: string } };
    expect(result.content).toBe("Hello there");
    expect(result.thoughts).toBe("why");
    expect(result.toolCalls?.[0]).toEqual({ id: "c1", name: "get_weather", input: { city: "SF" } });
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.finishReason).toBe("tool_use");
  });
});

describe("OpenAI Responses — streaming parse", () => {
  it("deltas, thoughts, tool-call accumulation, and usage from the terminal event", async () => {
    // arguments accumulate to {"location":9}: quote-free body keeps the SSE
    // strings manageable while still exercising item_id-keyed accumulation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
          'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","item_id":"i1","name":"get_weather","arguments":"{\\"location\\":"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"i1","delta":"9}"}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":34,"total_tokens":46}}}\n\n',
        ]),
      } as unknown as Response)),
    );

    const chunks: { content: string; isThoughts?: boolean }[] = [];
    const result = await new OpenAIAdapter().call(
      { provider: "openai", modelName: "gpt-5.2", apiKey: "k", apiEndpoint: "openai-responses", thinkingLevel: "low" },
      LLM_REQ,
      (c) => chunks.push(c),
    );

    expect(chunks).toEqual([
      { content: "Hi", isThoughts: false },
      { content: "think", isThoughts: true },
    ]);
    expect(result.content).toBe("Hi");
    expect(result.thoughts).toBe("think");
    expect(result.toolCalls?.[0]?.name).toBe("get_weather");
    expect(result.toolCalls?.[0]?.input).toEqual({ location: 9 });
    expect(result.toolCalls?.[0]?.id).toBe("call_0");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  });
});
