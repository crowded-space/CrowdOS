import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJsonOrThrow } from "./client";

// Audit §2.7: the server answers Zod failures with
// { message: "Validation failed", details: [{ path, message }] }.
// The old readApiError kept only the message, so toasts showed
// "Validation failed" with zero field feedback.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api error surfacing", () => {
  it("appends per-issue validation details to the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          statusCode: 400,
          error: "Bad Request",
          message: "Validation failed",
          details: [
            { path: "instructionModuleId", message: "Invalid input: expected string, received null" },
          ],
        }),
      })),
    );

    await expect(
      fetchJsonOrThrow("/api/agents", { method: "POST", body: "{}" }, "Failed to create agent."),
    ).rejects.toThrow(/Validation failed \(instructionModuleId: Invalid input/);
  });

  it("keeps the plain message when the body carries no details array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ message: "Backend unavailable" }),
      })),
    );

    await expect(fetchJsonOrThrow("/api/agents", {}, "Failed.")).rejects.toThrow(/^Backend unavailable$/);
  });
});
