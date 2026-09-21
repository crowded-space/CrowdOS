import { describe, it, expect, afterEach } from "vitest";
import { ConversationalRuntime } from "./conversational-runtime.js";
import { AgenticRuntime } from "./agentic-runtime.js";
import { CodingRuntime } from "./coding-runtime.js";
import { ResearchRuntime } from "./research-runtime.js";
import { SwarmRuntime } from "./swarm-runtime.js";
import type { IRuntime } from "../types.js";

/**
 * §23 Conformance Requirement: every runtime — composed, forked, or dedicated —
 * must honor the same contract and the same cross-cutting behaviours. §23 calls
 * a runtime that behaves differently "a defect, not a design choice", so the
 * rule is asserted here rather than left to review.
 *
 * This suite is deliberately structural: it checks the properties that every
 * consumer depends on, not the behaviour of any one runtime. Behavioural
 * coverage lives in each runtime's own test file.
 */
const ALL_RUNTIMES: Array<[string, IRuntime]> = [
  ["conversational", new ConversationalRuntime()],
  ["agentic", new AgenticRuntime()],
  ["coding", new CodingRuntime()],
  ["research", new ResearchRuntime()],
  ["swarm", new SwarmRuntime()],
];

// §25: the reachability test below must ENABLE research/swarm to observe them,
// so it has to restore the flags it set. Leaking them into the rest of the
// worker would make later suites see a configuration the product does not ship.
const ORIGINAL_FLAGS = {
  RESEARCH_V1: process.env.RESEARCH_V1,
  SWARM_V1: process.env.SWARM_V1,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_FLAGS)) {
    if (value === undefined) delete (process.env as Record<string, unknown>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describe("§23 runtime contract conformance", () => {
  it("exposes exactly the five decided runtimes (§22)", () => {
    expect(ALL_RUNTIMES.map(([name]) => name).sort()).toEqual([
      "agentic",
      "coding",
      "conversational",
      "research",
      "swarm",
    ]);
  });

  it.each(ALL_RUNTIMES)("%s implements IRuntime (type + execute)", (_name, runtime) => {
    expect(typeof runtime.type).toBe("string");
    expect(typeof runtime.execute).toBe("function");
  });

  it.each(ALL_RUNTIMES)("%s declares a unique runtime type", (name, runtime) => {
    expect(runtime.type).toBe(name);
  });

  it("Auto can select every runtime the contract exposes (§25)", async () => {
    // Guards against the two lists drifting: a runtime added to the map but
    // unreachable from Auto would be a selection path that cannot reach it.
    const { RuntimeRouter } = await import("../runtime-router.js");
    const router = new RuntimeRouter();
    // NOTE: RESEARCH_V1 / SWARM_V1 default to FALSE, which rolls both runtimes
    // back to agentic. This test therefore asserts reachability under the
    // ENABLED configuration, not the shipped default — the default is a
    // deliberately narrower set. Restored by afterEach.
    process.env.RESEARCH_V1 = "true";
    process.env.SWARM_V1 = "true";
    const reachable = new Set<string>();
    for (const [mode] of [
      ["chat"],
      ["agentic"],
      ["coding"],
      ["research"],
    ] as const) {
      for (const level of [0, 1, 2, 3]) {
        reachable.add(
          router.route({
            agent: { id: "a", name: "A", authorityLevel: level } as never,
            interpreterOutput: {
              targets: [],
              mode: mode as never,
              executionHints: [],
              ambiguous: false,
              assumptions: [],
            },
          }),
        );
      }
    }
    reachable.add(router.route({ agent: { id: "a", name: "A", authorityLevel: 2 } as never }));
    for (const [name] of ALL_RUNTIMES) {
      expect(reachable.has(name), `${name} is not reachable from Auto`).toBe(true);
    }
  });

  // §34 honesty: with the SHIPPED defaults (RESEARCH_V1 / SWARM_V1 both false)
  // the reachable set is deliberately narrower — both roll back to agentic.
  // Stating that as a test keeps §34's "Auto can reach all five" claim from
  // being read as a default-configuration guarantee it never was.
  it("with the shipped defaults, research and swarm roll back to agentic (§23/§34)", async () => {
    const { RuntimeRouter } = await import("../runtime-router.js");
    const router = new RuntimeRouter();
    delete (process.env as Record<string, unknown>).RESEARCH_V1;
    delete (process.env as Record<string, unknown>).SWARM_V1;

    const research = router.decide({ agent: { id: "a", name: "A", authorityLevel: 1 } as never, explicitRuntime: "research" });
    expect(research.runtime).toBe("agentic");
    expect(research.reason).toBe("rollback");
    expect(research.rolledBackFrom).toBe("research");

    const swarm = router.decide({ agent: { id: "a", name: "A", authorityLevel: 2 } as never, explicitRuntime: "swarm" });
    expect(swarm.runtime).toBe("agentic");
    expect(swarm.reason).toBe("rollback");
    expect(swarm.rolledBackFrom).toBe("swarm");

    // The runtimes that ship enabled still reach their own engine.
    expect(router.route({ agent: { id: "a", name: "A", authorityLevel: 1 } as never, explicitRuntime: "coding" })).toBe("coding");
    expect(router.route({ agent: { id: "a", name: "A", authorityLevel: 1 } as never, explicitRuntime: "conversational" })).toBe("conversational");
  });

  it("the §26 result contract is exhaustive (compile-time)", () => {
    // `Exhaustive` requires EVERY key of RuntimeResult to be present in the
    // literal below. Dropping a field from the contract makes this fail to
    // compile, which is the point: consumers read these fields, so a silent
    // removal must break the build rather than surface as undefined at runtime.
    type Result = import("../types.js").RuntimeResult;
    type Exhaustive<T> = { [K in keyof Required<T>]: unknown };
    const sample: Exhaustive<Result> = {
      requestId: "r",
      agentId: "a",
      channelId: "c",
      finalResponse: "text",
      internalMonologue: undefined,
      toolCalls: undefined,
      memoryCandidates: undefined,
      artifacts: undefined,
      runtimeEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: "completed",
    };
    expect(Object.keys(sample)).toContain("artifacts");
  });
});
