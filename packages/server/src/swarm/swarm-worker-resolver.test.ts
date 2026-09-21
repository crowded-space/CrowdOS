import { describe, it, expect } from "vitest";
import { resolveWorker, WorkerUnavailableError } from "./swarm-worker-resolver.js";
import type { AgentProfile } from "../agents/agent-gate.js";

const agent = (id: string, name: string, authorityLevel: number): AgentProfile =>
  ({ id, name, authorityLevel, status: "idle" }) as AgentProfile;

const ORCHESTRATOR = agent("agent-l2", "Orchestrator", 2);
const L1 = agent("agent-l1", "Specialist", 1);
const WORKER_A = agent("agent-w1", "Crow-Alpha", 3);
const WORKER_B = agent("agent-w2", "Crow-Beta", 3);
const ROSTER = [ORCHESTRATOR, L1, WORKER_A, WORKER_B];

describe("swarm worker resolution (§22/§31)", () => {
  it("resolves a named L3 worker by id", () => {
    const r = resolveWorker("agent-w2", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.id).toBe("agent-w2");
    expect(r.matchKind).toBe("id");
    expect(r.honestSubstitution).toBeUndefined();
  });

  it("resolves a named L3 worker by name, case-insensitively", () => {
    const r = resolveWorker("crow-alpha", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.id).toBe("agent-w1");
    expect(r.matchKind).toBe("name");
  });

  it("does NOT hand work back to the orchestrator when the plan names it", () => {
    // This is the defect the resolver exists to prevent: the planner's own
    // prompt used to suggest the requesting agent id, so an id-first resolver
    // would silently re-run the orchestrator for every subtask.
    const r = resolveWorker("agent-l2", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.authorityLevel).toBe(3);
    expect(r.agent.id).not.toBe("agent-l2");
    expect(r.matchKind).toBe("any-l3");
    expect(r.honestSubstitution).toMatch(/not the worker tier/);
  });

  it("does NOT hand work to a non-worker tier by name either", () => {
    const r = resolveWorker("Specialist", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.authorityLevel).toBe(3);
    expect(r.honestSubstitution).toMatch(/not the worker tier/);
  });

  it("treats the literal L3 hint as a request for a worker", () => {
    const r = resolveWorker("L3", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.authorityLevel).toBe(3);
    expect(r.matchKind).toBe("level");
    expect(r.honestSubstitution).toBeUndefined();
  });

  it("discloses a level request that is not the worker tier", () => {
    const r = resolveWorker("L1", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.id).toBe("agent-l1");
    expect(r.matchKind).toBe("level");
    expect(r.honestSubstitution).toMatch(/not the worker tier/);
  });

  it("substitutes a real worker for an unknown assignee, and says so", () => {
    const r = resolveWorker("does-not-exist", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.authorityLevel).toBe(3);
    expect(r.honestSubstitution).toMatch(/is not a known agent/);
  });

  it("falls back to a worker when the plan gave no assignee", () => {
    const r = resolveWorker("", ROSTER, { requestingAgent: ORCHESTRATOR });
    expect(r.agent.authorityLevel).toBe(3);
    expect(r.honestSubstitution).toMatch(/no assignee in plan/);
  });

  it("honors exclusions so two tasks do not collide on one worker", () => {
    const r = resolveWorker("agent-w1", ROSTER, {
      requestingAgent: ORCHESTRATOR,
      excludeIds: new Set(["agent-w1"]),
    });
    expect(r.agent.id).not.toBe("agent-w1");
  });

  it("never invents a worker when no L3 exists", () => {
    // A fabricated worker is a fabricated result — the resolver must fail loudly
    // rather than quietly re-running the orchestrator.
    expect(() =>
      resolveWorker("L3", [ORCHESTRATOR, L1], { requestingAgent: ORCHESTRATOR }),
    ).toThrow(WorkerUnavailableError);
  });

  it("runs as the requesting agent only when that agent is itself an L3", () => {
    const soloL3 = agent("agent-solo", "Solo", 3);
    const r = resolveWorker("agent-solo", [soloL3], { requestingAgent: soloL3 });
    expect(r.agent.id).toBe("agent-solo");
    expect(r.matchKind).toBe("id");
  });

  it("reports a stated substitution for a single-tier L3 workspace", () => {
    const soloL3 = agent("agent-solo", "Solo", 3);
    const r = resolveWorker("missing", [soloL3], { requestingAgent: soloL3 });
    expect(r.matchKind).toBe("any-l3");
    expect(r.honestSubstitution).toMatch(/is not a known agent/);
  });
});
