// CrowdOS §21 — the deferral SAFETY INVARIANT.
//
// Deferring a tool’s schema saves tokens, but it can also make the tool
// invisible. That is only acceptable if every deferred tool stays REACHABLE:
// the model must be able to discover that it exists and load it on demand.
//
// This file pins that invariant against the LIVE registry and catalog. If someone
// defers a tool that no capability names and that has no other route back, these
// tests fail — which is the whole point: silent capability loss is the failure
// mode §21 deferral introduces, so it gets an explicit guard.
import { describe, expect, it } from "vitest";

import { toolRegistry } from "../../tools/tools-gate.js";
import { DEFERRED_TOOL_IDS } from "./middlewares/tool-schema-middleware.js";
import { BUILTIN_CAPABILITIES } from "../../capabilities/capabilities-gate.js";

/** Tools named by at least one capability descriptor (discoverable + expandable). */
function capabilityNamedTools(): Set<string> {
  const named = new Set<string>();
  for (const cap of BUILTIN_CAPABILITIES) {
    for (const t of cap.tools) named.add(t);
  }
  return named;
}

describe("§21 deferral never makes a tool unreachable", () => {
  it("defers only tools that exist in the registry", () => {
    const missing = [...DEFERRED_TOOL_IDS].filter((id) => !toolRegistry.has(id));
    expect(missing).toEqual([]);
  });

  it("every deferred tool is named by a capability descriptor", () => {
    // A deferred tool with no descriptor is still reachable via open_detail’s
    // tool_id escape hatch, but it would be INVISIBLE — the model would have no
    // way to learn it exists. That is a capability loss, so require a descriptor.
    const named = capabilityNamedTools();
    const unnamed = [...DEFERRED_TOOL_IDS].filter((id) => !named.has(id));
    expect(unnamed).toEqual([]);
  });

  it("keeps the expansion verbs in the reflex set (never deferred)", () => {
    // If open_detail or load_skill were deferred, the agent could not load what
    // was deferred — the whole scheme would deadlock.
    expect(DEFERRED_TOOL_IDS.has("open_detail")).toBe(false);
    expect(DEFERRED_TOOL_IDS.has("load_skill")).toBe(false);
  });

  it("keeps context control and memory tools in the reflex set", () => {
    // Tiny, near-universally relevant, and §12 depends on lock tools being
    // available without a discovery round-trip.
    for (const id of ["lock_in", "lock_out", "open_memory", "remember", "discard_memory_from_context"]) {
      expect(DEFERRED_TOOL_IDS.has(id), id).toBe(false);
    }
  });

  it("every deferred tool is reachable by id through the escape hatch", () => {
    // The escape hatch resolves through the registry, so existence is the
    // requirement. Combined with the descriptor check above, this proves both
    // discoverability AND reachability for every deferred id.
    for (const id of DEFERRED_TOOL_IDS) {
      expect(toolRegistry.has(id), id).toBe(true);
    }
  });

  it("actually defers something (the mechanism is live, not dead code)", () => {
    expect(DEFERRED_TOOL_IDS.size).toBeGreaterThan(0);
  });
});
