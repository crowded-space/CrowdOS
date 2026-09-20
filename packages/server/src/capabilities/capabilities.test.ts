// CrowdOS §21 — capability vocabulary, discovery, and lazy expansion.
//
// These tests pin the three properties the document requires of capabilities
// (externalized / discoverable / lazily expanded) and the two invariants that
// make them safe to expose:
//
//   1. A capability with no LIVE tool for the agent is never advertised.
//   2. Expansion can never disclose more than the agent is authorized for,
//      and can never grant access (authorization stays in ToolExecutor).
//
// Harness note: the tool/skill tiers are mocked ONCE in beforeAll and the gate
// is imported ONCE, so the statically imported local-file module and the one the
// service resolves are the same instance. That is what lets
// setLocalStoreDirForTests redirect the manifest read. Per-test
// vi.resetModules() would sever that link and send reads to the real localstore.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";

let dir: string;

// Mutable tier state read by the mock factories at CALL time.
const tierState = {
  liveTools: [] as string[],
  authorized: [] as string[],
  resolverThrows: false,
};

let capabilitiesGate: typeof import("./capabilities-gate.js").capabilitiesGate;
let mergeManifest: typeof import("./capabilities-gate.js").mergeManifest;
let BUILTIN_CAPABILITIES: typeof import("./capabilities-gate.js").BUILTIN_CAPABILITIES;
let CAPABILITY_DOMAINS: typeof import("./capabilities-gate.js").CAPABILITY_DOMAINS;

function mockTiers(opts: { liveTools: string[]; authorized: string[]; resolverThrows?: boolean }) {
  tierState.liveTools = opts.liveTools;
  tierState.authorized = opts.authorized;
  tierState.resolverThrows = opts.resolverThrows ?? false;
}

beforeAll(async () => {
  vi.doMock("../tools/tools-gate.js", () => ({
    toolsGate: {
      has: (id: string) => tierState.liveTools.includes(id),
      get: (id: string) =>
        tierState.liveTools.includes(id)
          ? { name: id, description: `live ${id}`, parameters: { type: "object", properties: {} } }
          : undefined,
    },
  }));
  vi.doMock("../skills/skills-gate.js", () => ({
    skillsGate: {
      getResolvedToolsForAgent: async () => {
        if (tierState.resolverThrows) throw new Error("NO_DATABASE");
        return tierState.authorized;
      },
    },
  }));
  const mod = await import("./capabilities-gate.js");
  capabilitiesGate = mod.capabilitiesGate;
  mergeManifest = mod.mergeManifest;
  BUILTIN_CAPABILITIES = mod.BUILTIN_CAPABILITIES;
  CAPABILITY_DOMAINS = mod.CAPABILITY_DOMAINS;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-cap-"));
  setLocalStoreDirForTests(dir);
  mockTiers({ liveTools: [], authorized: [] });
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("../skills/skills-gate.js");
  vi.doUnmock("../tools/tools-gate.js");
});

describe("§21 vocabulary shape", () => {
  it("declares all eight operational domains", () => {
    expect([...CAPABILITY_DOMAINS]).toEqual([
      "workspace", "memory", "tooling", "planning",
      "execution", "swarm", "observation", "knowledge",
    ]);
  });

  it("uses the document’s vocabulary ids verbatim", () => {
    const ids = new Set(BUILTIN_CAPABILITIES.map((c) => c.id));
    for (const id of [
      "filesystem.read", "filesystem.write", "workspace.snapshot", "artifact.create",
      "memory.find", "memory.expand", "memory.commit", "memory.link",
      "tool.search", "tool.invoke", "open_detail",
      "task.plan", "task.breakdown", "objective.track",
      "sandbox.exec", "runtime.spawn", "job.await",
      "agent.spawn", "swarm.create", "task.delegate", "result.aggregate",
      "workspace.scan", "dependency.inspect", "anomaly.detect",
      "web.search", "repo.map", "docs.index",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("places every descriptor in one of the eight domains", () => {
    for (const c of BUILTIN_CAPABILITIES) {
      expect(CAPABILITY_DOMAINS as readonly string[]).toContain(c.domain);
    }
  });

  it("is externalized data, not prompt prose", () => {
    for (const c of BUILTIN_CAPABILITIES) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.summary).toBe("string");
      expect(Array.isArray(c.tools)).toBe(true);
      // The discovery line is the token-economy unit: exactly one line.
      expect(c.summary.includes("\n")).toBe(false);
    }
  });
});

describe("§21 discoverability", () => {
  it("advertises only capabilities with a live AND authorized tool", async () => {
    mockTiers({ liveTools: ["read_file", "list_directory", "remember"], authorized: ["read_file", "list_directory"] });
    const ids = (await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id);
    expect(ids).toContain("filesystem.read");
    // remember is live but NOT authorized -> hidden.
    expect(ids).not.toContain("memory.commit");
    // execute_bash/execute_safe are not live -> hidden.
    expect(ids).not.toContain("sandbox.exec");
  });

  it("never advertises a capability whose tools are all absent from the registry", async () => {
    mockTiers({ liveTools: [], authorized: ["read_file"] });
    expect(await capabilitiesGate.visibleFor("agent-1")).toEqual([]);
  });

  it("returns summaries without argument schemas (the token-economy contract)", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    const visible = await capabilitiesGate.visibleFor("agent-1");
    expect(visible.length).toBeGreaterThan(0);
    for (const v of visible) {
      expect(Object.keys(v).sort()).toEqual(["available", "domain", "id", "summary"]);
    }
  });

  it("degrades to no capabilities when the resolver is unavailable (no PG)", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: [], resolverThrows: true });
    expect(await capabilitiesGate.visibleFor("agent-1")).toEqual([]);
  });
});

describe("§21 lazy expansion", () => {
  it("expands one capability into full tool schemas", async () => {
    mockTiers({ liveTools: ["read_file", "list_directory"], authorized: ["read_file", "list_directory"] });
    const expanded = await capabilitiesGate.expand("agent-1", "filesystem.read");
    expect(expanded).not.toBeNull();
    expect(expanded!.id).toBe("filesystem.read");
    expect(expanded!.toolSchemas.map((t) => t.name).sort()).toEqual(["list_directory", "read_file"]);
    for (const t of expanded!.toolSchemas) expect(t.inputSchema).toBeDefined();
  });

  it("scopes expansion to the agent’s authorization", async () => {
    mockTiers({ liveTools: ["read_file", "list_directory"], authorized: ["list_directory"] });
    const expanded = await capabilitiesGate.expand("agent-1", "filesystem.read");
    expect(expanded).not.toBeNull();
    expect(expanded!.toolSchemas.map((t) => t.name)).toEqual(["list_directory"]);
  });

  it("returns null for a capability the agent was never offered", async () => {
    mockTiers({ liveTools: ["execute_bash"], authorized: ["read_file"] });
    expect(await capabilitiesGate.expand("agent-1", "sandbox.exec")).toBeNull();
  });

  it("returns null for an unknown capability id", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    expect(await capabilitiesGate.expand("agent-1", "does.not.exist")).toBeNull();
  });
});

describe("§30 workspace manifest overlay", () => {
  function writeManifest(obj: unknown) {
    writeFileSync(join(dir, "capabilities.json"), JSON.stringify(obj), "utf8");
  }

  it("hides a capability the workspace disabled", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    writeManifest({ disabled: ["filesystem.read"] });
    expect(await capabilitiesGate.get("filesystem.read")).toBeNull();
    expect(await capabilitiesGate.visibleFor("agent-1")).toEqual([]);
  });

  it("adds a workspace-specific capability over the built-in vocabulary", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    writeManifest({
      capabilities: [
        { id: "house.style", domain: "knowledge", summary: "Apply this workspace’s house style.", tools: ["read_file"] },
      ],
    });
    const d = await capabilitiesGate.get("house.style");
    expect(d).not.toBeNull();
    expect(d!.source).toBe("manifest");
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("house.style");
  });

  it("degrades to the built-in vocabulary when the manifest is malformed", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    writeFileSync(join(dir, "capabilities.json"), "{ not valid json", "utf8");
    expect(await capabilitiesGate.get("filesystem.read")).not.toBeNull();
  });
});

describe("§21 overlay merge is pure and order-stable", () => {
  it("merges by id, overrides fields, and removes disabled ids", () => {
    const builtins = [
      { id: "a.one", domain: "memory" as const, summary: "one", tools: ["t1"], source: "builtin" as const },
      { id: "b.two", domain: "knowledge" as const, summary: "two", tools: ["t2"], source: "builtin" as const },
    ];
    const merged = mergeManifest(builtins, {
      capabilities: [{ id: "a.one", summary: "one overridden" }],
      disabled: ["b.two"],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe("one overridden");
    expect(merged[0].tools).toEqual(["t1"]);
    expect(merged[0].domain).toBe("memory");
    expect(merged[0].source).toBe("manifest");
  });

  it("ignores manifest entries that cannot be placed in a domain", () => {
    expect(mergeManifest([], { capabilities: [{ id: "orphan.cap" }] })).toEqual([]);
  });
});
