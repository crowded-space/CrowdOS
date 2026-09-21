import { describe, it, expect } from "vitest";
import { ToolExecutor } from "./tool-executor.js";
import { ToolTimeoutError } from "./tool-types.js";

/**
 * §31: an L3 worker is stateless — "no private memory carried between tasks".
 *
 * Suppressing only the reflection note left the `remember` TOOL reachable, so a
 * worker could still write a permanent memory note. These tests pin the rule at
 * the executor, which is where every other tool authorization is enforced.
 */
describe("§31 stateless worker — memory writes are refused at the executor", () => {
  it("refuses `remember` for a stateless worker, with a reason the worker can act on", async () => {
    const result = await ToolExecutor.execute(
      "agent-l3-worker",
      "remember",
      { hook: "leaked", brief: "should never persist", note_type: "episodic" },
      { channelId: "ch-1", workspaceId: "ws-1", stateless: true } as never,
    ).catch((err: unknown) => ({ success: false, error: String((err as Error)?.message ?? err) }));

    expect(result.success).toBe(false);
    // The refusal must NAME the rule and the alternative — a bare "denied"
    // leaves the worker retrying the same call.
    expect(result.error).toMatch(/stateless/i);
    expect(result.error).toMatch(/§31|L3/);
  });

  it("refuses `discard_memory_from_context` for a stateless worker", async () => {
    const result = await ToolExecutor.execute(
      "agent-l3-worker",
      "discard_memory_from_context",
      { note_id: "note-1" },
      { channelId: "ch-1", workspaceId: "ws-1", stateless: true } as never,
    ).catch((err: unknown) => ({ success: false, error: String((err as Error)?.message ?? err) }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/stateless/i);
  });

  it("does NOT apply the stateless rule to ordinary agents", async () => {
    // Same call, no `stateless` flag: it must fail for its OWN reason (agent not
    // found / unauthorized), never because of the worker rule. This is the
    // control that keeps the guarantee from becoming a blanket block.
    const result = await ToolExecutor.execute(
      "agent-not-a-worker",
      "remember",
      { hook: "h", brief: "b", note_type: "episodic" },
      { channelId: "ch-1", workspaceId: "ws-1" } as never,
    ).catch((err: unknown) => ({ success: false, error: String((err as Error)?.message ?? err) }));

    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/stateless/i);
  });

  it("exports the timeout error type the executor contract promises", () => {
    expect(ToolTimeoutError).toBeTypeOf("function");
  });
});
