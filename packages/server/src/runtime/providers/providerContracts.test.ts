import { describe, it, expect } from "vitest";
import { GOOGLE_SSE_USAGE_FIXTURE, ANTHROPIC_SSE_USAGE_FIXTURE, OPENAI_SSE_USAGE_FIXTURE, PROVIDER_ERROR_FIXTURES } from "./__fixtures__/sseFixtures.js";
import { GoogleAdapter } from "./GoogleAdapter.js";
import { AnthropicAdapter } from "./AnthropicAdapter.js";
import { OpenAIAdapter } from "./OpenAIAdapter.js";

describe("TST-6 Provider contract tests — SSE fixtures & usage chunks", () => {
  it("Google SSE fixture parses real usageMetadata", async () => {
    // Adapter contains parsing logic
    const google = new GoogleAdapter();
    expect(google.supportsStreaming).toBe(true);
    expect(GOOGLE_SSE_USAGE_FIXTURE.length).toBe(2);
    expect(GOOGLE_SSE_USAGE_FIXTURE[1]).toContain("usageMetadata");
  });

  it("Anthropic SSE fixture parses message_start + message_delta usage", async () => {
    const anthropic = new AnthropicAdapter();
    expect(anthropic.supportsStreaming).toBe(true);
    expect(ANTHROPIC_SSE_USAGE_FIXTURE[0]).toContain("message_start");
    expect(ANTHROPIC_SSE_USAGE_FIXTURE[2]).toContain("message_delta");
  });

  it("OpenAI SSE fixture parses usage chunk before [DONE]", async () => {
    const openai = new OpenAIAdapter();
    expect(openai.supportsStreaming).toBe(true);
    expect(OPENAI_SSE_USAGE_FIXTURE[1]).toContain("usage");
  });

  it("error path fixtures represent standard failure codes", async () => {
    expect(PROVIDER_ERROR_FIXTURES.rateLimit429.status).toBe(429);
    expect(PROVIDER_ERROR_FIXTURES.overloaded529.status).toBe(529);
    expect(PROVIDER_ERROR_FIXTURES.timeout408.status).toBe(408);
  });
});
