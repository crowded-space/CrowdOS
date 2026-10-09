// STATE-002 / STATE-003 regression guards (fix-state-micro-002-003);
// STATE-005 / STATE-007 guards added by fix-state-micro-005-007.
//
// STATE-003: applyRunTransition must hand errorCode to runsGate.transition
// unchanged. undefined = leave the stored code (runs-repository RUN-001
// sticky semantics), null = explicit clear. The pre-fix gate normalized
// undefined to null at the boundary, erasing stored failure codes on
// reason-only hops.
//
// STATE-002: exactly one run.status_changed per changed transition through
// the gate; rejections and no-ops emit nothing. Approval decide paths
// (sweeper, REST, socket) funnel through the gate since XD-009; the
// remaining direct writers (tool-executor approval waits per XD-028,
// research-runtime child hops) are pinned by the bypass-set guard so a new
// bypass fails this suite and consolidation updates ledger + header in the
// same task.
//
// Hermetic: runs/messages boundaries are mocked; the event broker is the
// real in-memory EventBroker (no DB, no sockets).
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{
    runId: string;
    to: string;
    reason: string | null;
    errorCode: string | null | undefined;
    workspaceId: string | null | undefined;
  }>,
  errorCode: undefined as string | null | undefined,
  mode: "changed" as "changed" | "noop" | "reject",
}));

vi.mock("../runs/runs-gate.js", () => ({
  runsGate: {
    transition: async (
      runId: string,
      to: string,
      reason: string | null,
      errorCode: string | null | undefined,
      workspaceId: string | null | undefined,
    ) => {
      h.calls.push({ runId, to, reason, errorCode, workspaceId });
      if (h.mode === "reject") return null;
      // Mirror runs-repository RUN-001 sticky semantics: undefined leaves the
      // stored code, null clears it, a string sets it.
      if (errorCode !== undefined) h.errorCode = errorCode;
      return {
        row: {
          id: runId,
          status: to,
          errorCode: h.errorCode ?? null,
          agentId: "ag-1",
          channelId: "ch-1",
          workspaceId: workspaceId ?? null,
          runtimeType: "conversational",
        },
        from: "running",
        to,
        changed: h.mode === "changed",
        reason,
      };
    },
  },
}));

vi.mock("../messages/message-gate.js", () => ({
  messageGate: { append: async () => ({}) },
}));

import {
  EventBroker,
  resetSharedBrokerForTests,
  setSharedBroker,
} from "../event-broker/event-broker-gate.js";
import { resetPendingStatusEventsForTests, stateGate } from "./state-gate.js";

function captureStatusEvents(
  broker: EventBroker,
): Array<{ payload: Record<string, unknown>; channelId: string | undefined }> {
  const seen: Array<{ payload: Record<string, unknown>; channelId: string | undefined }> = [];
  broker.onAny((event) => {
    if (event.type !== "run.status_changed") return;
    seen.push({
      payload: event.payload as unknown as Record<string, unknown>,
      channelId: event.channelId,
    });
  });
  return seen;
}

beforeEach(() => {
  h.calls.length = 0;
  h.errorCode = undefined;
  h.mode = "changed";
  resetSharedBrokerForTests();
  resetPendingStatusEventsForTests();
});

describe("STATE-003: errorCode passthrough (RUN-001 mirrored through the gate)", () => {
  it("reason-only hop passes errorCode as undefined and preserves the stored code", async () => {
    h.errorCode = "E_BOOT";
    const outcome = await stateGate.applyRunTransition({
      runId: "r1",
      to: "waiting_for_tool",
      reason: "tool call",
      broker: new EventBroker(),
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].errorCode).toBeUndefined(); // pre-fix: null (cleared the stored code)
    expect(outcome).not.toBeNull();
    expect(outcome!.changed).toBe(true);
    expect(outcome!.row.errorCode).toBe("E_BOOT");
  });

  it("explicit null clears the stored code", async () => {
    h.errorCode = "E_BOOT";
    const outcome = await stateGate.applyRunTransition({
      runId: "r1",
      to: "failed",
      errorCode: null,
      broker: new EventBroker(),
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].errorCode).toBeNull();
    expect(outcome!.row.errorCode).toBeNull();
  });
});

describe("STATE-002: gate-side emission contract", () => {
  it("emits exactly one run.status_changed per changed transition with the observer payload", async () => {
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    const outcome = await stateGate.applyRunTransition({
      runId: "r1",
      to: "waiting_for_approval",
      reason: "approval_required:execute_bash:general",
      broker,
      workspaceId: "ws-1",
    });
    expect(outcome!.changed).toBe(true);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].payload).sort()).toEqual([
      "agentId",
      "channelId",
      "errorCode",
      "from",
      "reason",
      "runId",
      "runtimeType",
      "status",
      "workspaceId",
    ]);
    expect(events[0].payload.status).toBe("waiting_for_approval");
    expect(events[0].payload.workspaceId).toBe("ws-1");
    expect(events[0].channelId).toBe("ch-1"); // { channelId } room tag
  });

  it("emits nothing on a no-op and returns the unchanged outcome", async () => {
    h.mode = "noop";
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "waiting_for_tool", broker });
    expect(outcome).not.toBeNull();
    expect(outcome!.changed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("emits nothing when the transition is rejected (null)", async () => {
    h.mode = "reject";
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "waiting_for_tool", broker });
    expect(outcome).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("keeps direct runsGate.transition sites exactly at the documented bypass set", () => {
    const srcRoot = fileURLToPath(new URL("..", import.meta.url)); // packages/server/src/
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .map((p) => String(p).split(sep).join("/"))
      .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
    const direct: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(srcRoot, rel), "utf8");
      if (src.includes("runsGate.transition(")) direct.push(rel);
    }
    direct.sort();
    // Ledger STATE-002: the gate itself plus the two documented direct writers
    // that consolidation must remove (XD-028 tool-executor waits; research child hops).
    expect(direct).toEqual([
      "runtime/runtimes/research-runtime.ts",
      "state/state-gate.ts",
      "tools/tool-executor.ts",
    ]);
    // Approval decide paths funnel through stateGate since XD-009; a direct
    // call here is a regression back to the no-emit bypass.
    for (const funneled of [
      "approvals/approval-sweeper.ts",
      "routes/approvals.ts",
      "shared/sockets/register-socket-server.ts",
      "runtime/runtime-executor.ts",
    ]) {
      expect(direct).not.toContain(funneled);
    }
  });
});

describe("STATE-007: broker resolution and failure containment", () => {
  it("falls back to the shared broker when no explicit broker is passed", async () => {
    const shared = new EventBroker();
    setSharedBroker(shared);
    const events = captureStatusEvents(shared);
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "running" });
    expect(outcome!.changed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].payload.status).toBe("running");
    expect(events[0].channelId).toBe("ch-1");
  });

  it("warns and still returns the outcome when no broker is available (persistence unaffected)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "running" });
    expect(outcome).not.toBeNull();
    expect(outcome!.changed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no shared broker registered"));
    warn.mockRestore();
  });

  it("swallows an emit throw (console.error) and still returns the outcome", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = {
      emit: () => {
        throw new Error("broker down");
      },
    } as unknown as EventBroker;
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "running", broker: throwing });
    expect(outcome).not.toBeNull();
    expect(outcome!.changed).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Failed to emit"), expect.any(Error));
    error.mockRestore();
  });
});

describe("STATE-005: emit-gap repair (failure injection)", () => {
  it("buffers the status change when no broker exists and repairs it on flush", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Kill/restart shape: the transition persists (row changed) but no broker is registered.
    const outcome = await stateGate.applyRunTransition({ runId: "r1", to: "failed", errorCode: "E_BOOT" });
    expect(outcome!.changed).toBe(true);
    // Still no broker: nothing delivered, but nothing lost either.
    expect(await stateGate.flushPendingStatusEvents()).toBe(0);
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    // Repair leg: a later broker (boot / socket registration) delivers the missed change.
    expect(await stateGate.flushPendingStatusEvents(broker)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].payload.status).toBe("failed");
    expect(events[0].payload.errorCode).toBe("E_BOOT");
    expect(events[0].channelId).toBe("ch-1");
    expect(await stateGate.flushPendingStatusEvents(broker)).toBe(0); // drained
    warn.mockRestore();
  });

  it("buffers when the emit throws, then a later flush delivers it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = {
      emit: () => {
        throw new Error("broker down");
      },
    } as unknown as EventBroker;
    await stateGate.applyRunTransition({ runId: "r1", to: "running", broker: throwing });
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    expect(await stateGate.flushPendingStatusEvents(broker)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].payload.status).toBe("running");
    error.mockRestore();
  });

  it("keeps only the latest payload per run and repairs older gaps on the next live emit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await stateGate.applyRunTransition({ runId: "r1", to: "running" });
    await stateGate.applyRunTransition({ runId: "r1", to: "failed" });
    const broker = new EventBroker();
    const events = captureStatusEvents(broker);
    // r2 transitions live -> the gate repairs r1's gap (latest-wins) then emits r2.
    await stateGate.applyRunTransition({ runId: "r2", to: "running", broker });
    expect(events.map((e) => e.payload.runId)).toEqual(["r1", "r2"]);
    expect(events[0].payload.status).toBe("failed"); // latest r1 status, never the stale "running"
    warn.mockRestore();
  });
});
