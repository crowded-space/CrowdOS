import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIAdapter } from "./open-ai-adapter.js";
import { CustomAdapter } from "./custom-adapter.js";

/**
 * Live wire proof: each apiEndpoint dialect must hit a DIFFERENT URL on a
 * real HTTP server (not a fetch stub) with the dialect-correct body —
 * chat/completions + reasoning_effort vs /responses + reasoning.effort.
 * This is the "routed properly, not cosmetic" check: the fields must survive
 * the adapter branch to an actual network boundary.
 *
 * Google + Anthropic live hosts are pinned upstream (no endpointUrl), so they
 * are covered at the fetch-stub level in openai-responses.test.ts instead.
 */
const openai = new OpenAIAdapter();
const custom = new CustomAdapter();

interface RecordedRequest {
  url: string
  method: string
  body: string
  responded: boolean
}
const recorded: RecordedRequest[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rec: RecordedRequest = {
      url: req.url || "",
      method: req.method || "",
      body: Buffer.concat(chunks).toString("utf8"),
      responded: false,
    };
    recorded.push(rec);
    rec.responded = true;
    let payload: unknown;
    if (rec.url.endsWith("/responses")) {
      payload = {
        id: "resp_wire",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "wire-ok" }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      };
    } else {
      payload = {
        id: "cmpl_wire",
        choices: [{ message: { content: "wire-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
});

function base(): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/v1`;
}

const respondWith = (r: RecordedRequest) => JSON.parse(r.body) as Record<string, unknown>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(() => {
  server.close();
});

describe("apiEndpoint routing — live wire", () => {
  it("openai-completion dialect posts <base>/chat/completions with reasoning_effort", async () => {
    recorded.length = 0;
    const response = await openai.call(
      {
        provider: "openai",
        modelName: "gpt-5.2",
        apiKey: "k",
        endpointUrl: base(),
        apiEndpoint: "openai-completion",
        thinkingLevel: "high",
        temperature: 0.5,
      },
      { systemPrompt: "s", userPrompt: "u" },
    );

    expect(response.content).toBe("wire-ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/v1/chat/completions");
    const body = respondWith(recorded[0]);
    expect(body.reasoning_effort).toBe("high");
  });

  it("openai-responses dialect posts <base>/responses with reasoning.effort and no temperature", async () => {
    recorded.length = 0;
    const response = await openai.call(
      {
        provider: "openai",
        modelName: "gpt-5.2",
        apiKey: "k",
        endpointUrl: base(),
        apiEndpoint: "openai-responses",
        thinkingLevel: "max",
        temperature: 0.5,
      },
      { systemPrompt: "s", userPrompt: "u", temperature: 0.5 },
    );

    expect(response.content).toBe("wire-ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/v1/responses");
    const body = respondWith(recorded[0]);
    expect(body.reasoning).toEqual({ effort: "max" });
    expect(body.temperature).toBeUndefined();
    expect(response.usage?.totalTokens).toBe(19);
  });

  it("custom provider answers per endpointUrl: /responses dialect replaces chat/completions", async () => {
    recorded.length = 0;
    const response = await custom.call(
      {
        provider: "custom",
        modelName: "local-llama",
        apiKey: "k",
        endpointUrl: base(),
        apiEndpoint: "openai-responses",
        thinkingLevel: "none",
      },
      { systemPrompt: "s", userPrompt: "u" },
    );

    expect(response.content).toBe("wire-ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/v1/responses");
    const body = respondWith(recorded[0]);
    expect(body.reasoning).toBeUndefined();
  });
});
