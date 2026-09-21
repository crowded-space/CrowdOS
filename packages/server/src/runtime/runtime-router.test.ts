import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RuntimeRouter } from "./runtime-router.js";
import { interpret } from "./interpreter.js";
import type { RuntimeType } from "./types.js";

const agent = (level: number, id = "ag-1", name = "Agent") =>
  ({ id, name, authorityLevel: level }) as any;

describe("RuntimeRouter §24/§25 — Auto selection consumes the interpretation", () => {
  const origResearch = process.env.RESEARCH_V1;
  const origSwarm = process.env.SWARM_V1;

  beforeEach(() => {
    process.env.RESEARCH_V1 = "true";
    process.env.SWARM_V1 = "true";
  });

  afterEach(() => {
    if (origResearch === undefined) delete (process.env as Record<string, unknown>).RESEARCH_V1;
    else process.env.RESEARCH_V1 = origResearch;
    if (origSwarm === undefined) delete (process.env as Record<string, unknown>).SWARM_V1;
    else process.env.SWARM_V1 = origSwarm;
  });

  it("Auto can reach all five runtimes across tiers (§25)", () => {
    const router = new RuntimeRouter();
    const reached = new Set<RuntimeType>();
    const intents = ["chat", "agentic", "coding", "research"] as const;
    for (const level of [0, 1, 2, 3]) {
      for (const mode of intents) {
        reached.add(router.route({ agent: agent(level), interpreterOutput: interpret({ content: "", explicitRuntime: mode }) }));
      }
    }
    reached.add(router.route({ agent: agent(2) }));
    expect([...reached].sort()).toEqual(["agentic", "coding", "conversational", "research", "swarm"]);
  });

  it("consumes interpreter intent for Auto — the interpretation is not decorative (§24)", () => {
    const router = new RuntimeRouter();
    const a = agent(1);
    expect(router.route({ agent: a, interpreterOutput: interpret({ content: "please debug this stack trace" }) })).toBe("coding");
    expect(router.route({ agent: a, interpreterOutput: interpret({ content: "survey the literature and cite sources" }) })).toBe("research");
    expect(router.route({ agent: a, interpreterOutput: interpret({ content: "hey there" }) })).toBe("agentic");
  });

  it("never inverts authority-aware routing (§25)", () => {
    const router = new RuntimeRouter();
    // L3 must not receive the orchestrator engine even when intent/pin suggest it.
    expect(router.route({ agent: agent(3), preferredRuntime: "swarm" })).toBe("agentic");
    // L2 owns orchestration, so it reaches swarm without an explicit pin.
    expect(router.route({ agent: agent(2) })).toBe("swarm");
    // Reasoning tiers are never demoted to the most limited runtime.
    for (const level of [0, 1]) {
      expect(router.route({ agent: agent(level) })).toBe("agentic");
    }
  });

  it("explicit beats pin beats intent beats tier", () => {
    const router = new RuntimeRouter();
    const a = agent(1);
    const intent = interpret({ content: "debug this stack trace" }); // coding
    expect(router.decide({ agent: a, explicitRuntime: "conversational", preferredRuntime: "coding", interpreterOutput: intent }).reason).toBe("explicit");
    expect(router.decide({ agent: a, preferredRuntime: "conversational", interpreterOutput: intent }).reason).toBe("pin");
    expect(router.decide({ agent: a, interpreterOutput: intent }).reason).toBe("intent");
    expect(router.decide({ agent: a }).reason).toBe("tier");
  });

  it("reports rollback honestly instead of silently substituting", () => {
    process.env.RESEARCH_V1 = "false";
    const router = new RuntimeRouter();
    const decision = router.decide({ agent: agent(1), explicitRuntime: "research" });
    expect(decision.runtime).toBe("agentic");
    expect(decision.reason).toBe("rollback");
    expect(decision.rolledBackFrom).toBe("research");
  });

  it("resolves the librarian identity before any pin or intent", () => {
    const router = new RuntimeRouter();
    const lib = agent(2, "agent-librarian", "Librarian");
    expect(router.decide({ agent: lib, librarianAgentId: "agent-librarian", preferredRuntime: "coding" }).reason).toBe("librarian");
    expect(router.route({ agent: lib, librarianAgentId: "agent-librarian", preferredRuntime: "coding" })).toBe("research");
  });
});
