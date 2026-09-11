import { describe, expect, it } from "vitest";

import {
  RUN_STATES,
  TERMINAL_RUN_STATES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isRunState,
  isTerminal,
  transition,
  type RunState,
} from "./run-state-machine.js";

describe("runStateMachine", () => {
  it("exposes exactly the lifecycle states from the spec, lowercase", () => {
    expect(RUN_STATES).toEqual([
      "created",
      "queued",
      "starting",
      "running",
      "waiting_for_tool",
      "waiting_for_approval",
      "retrying",
      "compacting",
      "completing",
      "verifying",
      "completed",
      "failed",
      "cancelled",
      "cancelling",
      "orphaned",
      "resumable",
    ]);
  });

  it("marks completed | failed | cancelled as terminal and nothing else", () => {
    for (const state of RUN_STATES) {
      expect(isTerminal(state)).toBe((TERMINAL_RUN_STATES as readonly string[]).includes(state));
    }
  });

  it("allows every edge declared in the transition map", () => {
    for (const from of RUN_STATES) {
      for (const to of allowedTransitions(from)) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
        const verdict = transition(from, to);
        expect(verdict.ok).toBe(true);
        expect(verdict.noop).toBe(false);
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it("walks the main happy-path chain step by step", () => {
    const chain: RunState[] = [
      "created",
      "starting",
      "running",
      "completing",
      "verifying",
      "completed",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransition(chain[i], chain[i + 1]), `${chain[i]} -> ${chain[i + 1]}`).toBe(true);
    }
  });

  it("supports queued staging and resume paths", () => {
    expect(canTransition("created", "queued")).toBe(true);
    expect(canTransition("queued", "starting")).toBe(true);
    expect(canTransition("orphaned", "resumable")).toBe(true);
    expect(canTransition("resumable", "queued")).toBe(true);
  });

  it("treats running <-> waiting_for_tool / waiting_for_approval as bidirectional", () => {
    expect(canTransition("running", "waiting_for_tool")).toBe(true);
    expect(canTransition("waiting_for_tool", "running")).toBe(true);
    expect(canTransition("running", "waiting_for_approval")).toBe(true);
    expect(canTransition("waiting_for_approval", "running")).toBe(true);
  });

  it("re-enters running from retrying and compacting", () => {
    expect(canTransition("running", "retrying")).toBe(true);
    expect(canTransition("retrying", "running")).toBe(true);
    expect(canTransition("running", "compacting")).toBe(true);
    expect(canTransition("compacting", "running")).toBe(true);
  });

  it("reaches cancelling from live states and terminates via cancelled", () => {
    for (const live of [
      "created",
      "queued",
      "starting",
      "running",
      "waiting_for_tool",
      "waiting_for_approval",
      "retrying",
      "compacting",
      "completing",
      "verifying",
    ] as const) {
      expect(canTransition(live, "cancelling"), `${live} -> cancelling`).toBe(true);
    }
    expect(canTransition("cancelling", "cancelled")).toBe(true);
    expect(allowedTransitions("cancelling")).toEqual(["cancelled"]);
  });

  it("rejects representative illegal transitions", () => {
    const illegal: Array<[RunState, RunState]> = [
      ["completed", "running"],
      ["created", "completed"],
      ["created", "running"],
      ["running", "queued"],
      ["running", "created"],
      ["waiting_for_tool", "waiting_for_approval"],
      ["waiting_for_approval", "retrying"],
      ["resumable", "running"],
      ["orphaned", "running"],
      ["cancelling", "running"],
      ["cancelling", "failed"],
      ["starting", "completed"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      expect(transition(from, to).ok).toBe(false);
      expect(() => assertTransition(from, to)).toThrowError(/\[runStateMachine\] Illegal transition/);
    }
  });

  it("enforces terminal immutability: terminals transition nowhere except themselves", () => {
    for (const terminal of TERMINAL_RUN_STATES) {
      for (const other of RUN_STATES) {
        if (other === terminal) continue;
        expect(canTransition(terminal, other), `${terminal} -> ${other}`).toBe(false);
        expect(transition(terminal, other).ok).toBe(false);
      }
      expect(() => assertTransition(terminal, terminal)).not.toThrow();
    }
  });

  it("treats same-state transitions as legal no-ops everywhere", () => {
    for (const state of RUN_STATES) {
      const verdict = transition(state, state);
      expect(verdict.ok).toBe(true);
      expect(verdict.noop).toBe(true);
      expect(() => assertTransition(state, state)).not.toThrow();
    }
    expect(canTransition("failed", "failed")).toBe(true);
  });

  it("assertTransition returns the verdict instead of throwing when throwOnIllegal is false", () => {
    const verdict = assertTransition("completed", "running", { throwOnIllegal: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/immutable/);
  });

  it("guards against unknown states at runtime", () => {
    expect(isRunState("bogus")).toBe(false);
    expect(canTransition("bogus" as RunState, "running")).toBe(false);
    expect(transition("bogus" as RunState, "running").ok).toBe(false);
    expect(transition("running", "bogus" as RunState).ok).toBe(false);
  });

  it("never leaves a dead end except terminals: every non-terminal has an exit", () => {
    for (const state of RUN_STATES) {
      if (isTerminal(state)) {
        expect(allowedTransitions(state)).toEqual([]);
      } else {
        expect(allowedTransitions(state).length, state).toBeGreaterThan(0);
      }
    }
  });
});
