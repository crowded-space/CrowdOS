// CrowdOS §21 catalog integrity — checked against the REAL tool registry.
//
// Kept in its own file because the sibling capabilities.test.ts mocks the tool
// and skill tiers to test discovery in isolation, and a mock would make this
// assertion vacuous. Here nothing is mocked, so `toolRegistry.has` is the same
// registry ToolExecutor authorizes against.
import { describe, expect, it } from "vitest";

import { BUILTIN_CAPABILITIES, CAPABILITY_DOMAINS } from "./capabilities-gate.js";
import { toolRegistry } from "../tools/tools-gate.js";

describe("§21 catalog integrity against the live registry", () => {
  it("names only tool ids that exist in the registry", () => {
    // A descriptor pointing at a tool id that no longer exists would silently
    // drop out of discovery — correct at runtime, but a maintenance trap: the
    // capability would just quietly vanish. Pin it.
    const unknown: string[] = [];
    for (const c of BUILTIN_CAPABILITIES) {
      for (const t of c.tools) {
        if (!toolRegistry.has(t)) unknown.push(`${c.id} -> ${t}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("has at least one REALIZED capability in every domain that can be realized today", () => {
    // Honesty check on the vocabulary: the domains that map to shipped tools
    // (workspace, memory, tooling, execution, knowledge) must actually surface
    // something, or the discovery layer is decorative.
    const realizedDomains = new Set(
      BUILTIN_CAPABILITIES.filter((c) => c.tools.some((t) => toolRegistry.has(t))).map((c) => c.domain),
    );
    for (const domain of ["workspace", "memory", "tooling", "execution", "knowledge"]) {
      expect(realizedDomains.has(domain as never), domain).toBe(true);
    }
  });

  it("keeps every declared domain reachable from the descriptor set", () => {
    const declared = new Set(BUILTIN_CAPABILITIES.map((c) => c.domain));
    // planning / swarm / observation are declared but not yet realized; they
    // must still be present in the catalog so the vocabulary tracks §21.
    for (const d of CAPABILITY_DOMAINS) expect(declared.has(d), d).toBe(true);
  });

  it("realizes the two expansion verbs the discovery layer depends on", () => {
    // Discovery without an expansion verb is a dead end: the agent would be told
    // about capabilities it can never pull in.
    expect(toolRegistry.has("open_detail")).toBe(true);
    expect(toolRegistry.has("load_skill")).toBe(true);
  });
});

