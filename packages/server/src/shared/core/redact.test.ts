import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts exact credential keys", () => {
    const out = redactSecrets({ apiKey: "sk-live-1234", password: "hunter2" });
    expect(out.apiKey).toBe("••••••••");
    expect((out as any).apiKey_configured).toBe(true);
    expect(out.password).toBe("••••••••");
  });

  it("does not mask numeric fields whose name merely contains 'token'", () => {
    // Regression: masking non-string values under /token/i keys turned
    // maxOutputTokens into a bullet string, corrupting the client edit
    // payload and failing every model-module update. Only strings mask.
    const row = { maxOutputTokens: 2048, maxRecentMessages: 10, apiKey: "k" };
    const out = redactSecrets(row);
    expect(out.maxOutputTokens).toBe(2048);
    expect(out.maxRecentMessages).toBe(10);
    expect(out.apiKey).toBe("••••");
  });
});
