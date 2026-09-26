// CrowdOS §21 — capability vocabulary, discovery, and lazy expansion.
//
// These tests pin the three properties the document requires of capabilities
// (externalized / discoverable / lazily expanded) and the two invariants that
// make them safe to expose:
//
//   1. A capability with no LIVE tool the agent is authorized for (grant plus
//      authority level) is never advertised.
//   2. Expansion can never disclose more than the agent is authorized for,
//      and can never grant access (authorization stays in ToolExecutor).
//
// Harness note: the tool/skill tiers are mocked ONCE in beforeAll and the gate
// is imported ONCE, so the statically imported local-file module and the one the
// service resolves are the same instance. That is what lets
// setLocalStoreDirForTests redirect the manifest read. Per-test
// vi.resetModules() would sever that link and send reads to the real localstore.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";

let dir: string;

// Mutable tier state read by the mock factories at CALL time.
const tierState = {
  liveTools: [] as string[],
  authorized: [] as string[],
  resolverThrows: false,
  authLevels: {} as Record<string, number>,
  agent: { authorityLevel: 1, isOmniscient: false } as { authorityLevel: number; isOmniscient: boolean } | null,
};

let capabilitiesGate: typeof import("./capabilities-gate.js").capabilitiesGate;
let mergeManifest: typeof import("./capabilities-gate.js").mergeManifest;
let BUILTIN_CAPABILITIES: typeof import("./capabilities-gate.js").BUILTIN_CAPABILITIES;
let CAPABILITY_DOMAINS: typeof import("./capabilities-gate.js").CAPABILITY_DOMAINS;
let listDescriptors: typeof import("./capability-service.js").listDescriptors;

function mockTiers(opts: {
  liveTools: string[];
  authorized: string[];
  resolverThrows?: boolean;
  authLevels?: Record<string, number>;
  agent?: { authorityLevel: number; isOmniscient: boolean } | null;
}) {
  tierState.liveTools = opts.liveTools;
  tierState.authorized = opts.authorized;
  tierState.resolverThrows = opts.resolverThrows ?? false;
  tierState.authLevels = opts.authLevels ?? {};
  tierState.agent = opts.agent === undefined ? { authorityLevel: 1, isOmniscient: false } : opts.agent;
}

beforeAll(async () => {
  vi.doMock("../tools/tools-gate.js", () => ({
    toolsGate: {
      has: (id: string) => tierState.liveTools.includes(id),
      get: (id: string) =>
        tierState.liveTools.includes(id)
          ? {
              name: id,
              description: `live ${id}`,
              parameters: { type: "object", properties: {} },
              authLevelRequired: tierState.authLevels[id],
            }
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
  vi.doMock("../agents/agent-gate.js", () => ({
    agentGate: {
      getById: async () => tierState.agent,
    },
  }));
  const mod = await import("./capabilities-gate.js");
  capabilitiesGate = mod.capabilitiesGate;
  mergeManifest = mod.mergeManifest;
  BUILTIN_CAPABILITIES = mod.BUILTIN_CAPABILITIES;
  CAPABILITY_DOMAINS = mod.CAPABILITY_DOMAINS;
  listDescriptors = (await import("./capability-service.js")).listDescriptors;
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
  vi.doUnmock("../agents/agent-gate.js");
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
    // A duplicate id would silently collapse under the merge-by-id map.
    expect(ids.size).toBe(BUILTIN_CAPABILITIES.length);
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
    mockTiers({
      liveTools: ["read_file", "list_directory", "remember"],
      authorized: ["read_file", "list_directory"],
      authLevels: { read_file: 3, list_directory: 3, remember: 3 },
    });
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
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], authLevels: { read_file: 3 } });
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

  it("returns no capabilities for an empty agent id", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    expect(await capabilitiesGate.visibleFor("")).toEqual([]);
  });

  it("returns no capabilities when the agent profile cannot be resolved", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], agent: null });
    expect(await capabilitiesGate.visibleFor("agent-1")).toEqual([]);
  });
});

describe("§21 authority-level filter mirrors ToolExecutor", () => {
  it("does not advertise sandbox.exec to an L3 agent whose live tools need more authority", async () => {
    mockTiers({
      liveTools: ["execute_bash"],
      authorized: ["execute_bash"],
      authLevels: { execute_bash: 1 },
      agent: { authorityLevel: 3, isOmniscient: false },
    });
    const ids = (await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id);
    expect(ids).not.toContain("sandbox.exec");
  });

  it("advertises sandbox.exec to an L0 or omniscient agent the executor would allow", async () => {
    mockTiers({
      liveTools: ["execute_bash"],
      authorized: ["execute_bash"],
      authLevels: { execute_bash: 1 },
      agent: { authorityLevel: 0, isOmniscient: false },
    });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("sandbox.exec");

    mockTiers({
      liveTools: ["execute_bash"],
      authorized: ["execute_bash"],
      authLevels: { execute_bash: 1 },
      agent: { authorityLevel: 3, isOmniscient: true },
    });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("sandbox.exec");
  });

  it("advertises only the authority-authorized subset of a partially authorized capability", async () => {
    // Real registry levels: execute_bash requires L0-L1, execute_safe is open to all.
    mockTiers({
      liveTools: ["execute_bash", "execute_safe"],
      authorized: ["execute_bash", "execute_safe"],
      authLevels: { execute_bash: 1, execute_safe: 3 },
      agent: { authorityLevel: 3, isOmniscient: false },
    });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("sandbox.exec");
    const expanded = await capabilitiesGate.expand("agent-1", "sandbox.exec");
    expect(expanded!.toolSchemas.map((t) => t.name)).toEqual(["execute_safe"]);
  });

  it("treats a tool with no declared authLevelRequired as L0-only, mirroring the executor's fail-closed default", async () => {
    // No authLevels entry -> undefined -> same `?? 0` ToolExecutor applies.
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], agent: { authorityLevel: 1, isOmniscient: false } });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).not.toContain("filesystem.read");
    expect(await capabilitiesGate.expand("agent-1", "filesystem.read")).toBeNull();

    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], agent: { authorityLevel: 0, isOmniscient: false } });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("filesystem.read");

    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], agent: { authorityLevel: 3, isOmniscient: true } });
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).toContain("filesystem.read");
  });
});

describe("§21 descriptor listing", () => {
  it("orders descriptors by §21 domain order, then id, stably across calls", async () => {
    const first = await listDescriptors();
    const second = await listDescriptors();
    expect(first).toEqual(second);
    const rank = new Map(CAPABILITY_DOMAINS.map((d, i) => [d, i]));
    for (let i = 1; i < first.length; i++) {
      const prev = first[i - 1];
      const cur = first[i];
      const dr = (rank.get(prev.domain) ?? 99) - (rank.get(cur.domain) ?? 99);
      const ordered = dr < 0 || (dr === 0 && prev.id.localeCompare(cur.id) < 0);
      expect(ordered, `${prev.id} then ${cur.id}`).toBe(true);
    }
  });
});

describe("§21 lazy expansion", () => {
  it("expands one capability into full tool schemas", async () => {
    mockTiers({
      liveTools: ["read_file", "list_directory"],
      authorized: ["read_file", "list_directory"],
      authLevels: { read_file: 3, list_directory: 3 },
    });
    const expanded = await capabilitiesGate.expand("agent-1", "filesystem.read");
    expect(expanded).not.toBeNull();
    expect(expanded!.id).toBe("filesystem.read");
    expect(expanded!.toolSchemas.map((t) => t.name).sort()).toEqual(["list_directory", "read_file"]);
    for (const t of expanded!.toolSchemas) expect(t.inputSchema).toBeDefined();
  });

  it("scopes expansion to the agent’s authorization", async () => {
    mockTiers({
      liveTools: ["read_file", "list_directory"],
      authorized: ["list_directory"],
      authLevels: { read_file: 3, list_directory: 3 },
    });
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

  it("returns null for a capability whose tools are authorized but none are live", async () => {
    mockTiers({ liveTools: [], authorized: ["read_file", "list_directory"] });
    expect(await capabilitiesGate.expand("agent-1", "filesystem.read")).toBeNull();
  });

  it("returns null when every live tool of the capability is above the agent’s authority", async () => {
    mockTiers({
      liveTools: ["execute_bash"],
      authorized: ["execute_bash"],
      authLevels: { execute_bash: 1 },
      agent: { authorityLevel: 3, isOmniscient: false },
    });
    expect(await capabilitiesGate.expand("agent-1", "sandbox.exec")).toBeNull();
  });

  it("returns null when the resolver is unavailable (no PG)", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], resolverThrows: true });
    expect(await capabilitiesGate.expand("agent-1", "filesystem.read")).toBeNull();
  });

  it("returns null for an empty agent id", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    expect(await capabilitiesGate.expand("", "filesystem.read")).toBeNull();
  });
});

describe("§30 workspace manifest overlay", () => {
  function writeManifest(obj: unknown) {
    // Canon: the overlay lives at <workspaceFolder>/vfs/.crowdos/capabilities.json.
    const crowdos = localStoreDirsForTests().crowdos;
    mkdirSync(crowdos, { recursive: true });
    writeFileSync(join(crowdos, "capabilities.json"), JSON.stringify(obj), "utf8");
  }

  it("hides a capability the workspace disabled", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    writeManifest({ disabled: ["filesystem.read"] });
    expect(await capabilitiesGate.get("filesystem.read", "default")).toBeNull();
    expect(await capabilitiesGate.visibleFor("agent-1", "default")).toEqual([]);
  });

  it("adds a workspace-specific capability over the built-in vocabulary", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"], authLevels: { read_file: 3 } });
    writeManifest({
      capabilities: [
        { id: "house.style", domain: "knowledge", summary: "Apply this workspace’s house style.", tools: ["read_file"] },
      ],
    });
    const d = await capabilitiesGate.get("house.style", "default");
    expect(d).not.toBeNull();
    expect(d!.source).toBe("manifest");
    expect((await capabilitiesGate.visibleFor("agent-1", "default")).map((v) => v.id)).toContain("house.style");
  });

  it("never leaks one workspace's manifest to unscoped callers (§30 isolation)", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    writeManifest({
      capabilities: [
        { id: "house.style", domain: "knowledge", summary: "Apply this workspace’s house style.", tools: ["read_file"] },
      ],
    });
    expect(await capabilitiesGate.get("house.style")).toBeNull();
    expect((await capabilitiesGate.visibleFor("agent-1")).map((v) => v.id)).not.toContain("house.style");
  });

  it("degrades to the built-in vocabulary when the manifest is malformed", async () => {
    mockTiers({ liveTools: ["read_file"], authorized: ["read_file"] });
    const crowdos = localStoreDirsForTests().crowdos;
    mkdirSync(crowdos, { recursive: true });
    writeFileSync(join(crowdos, "capabilities.json"), "{ not valid json", "utf8");
    expect(await capabilitiesGate.get("filesystem.read")).not.toBeNull();
  });

  it.each([
    [{ capabilities: "nope" }, "manifest.capabilities is not an array"],
    [{ capabilities: [{}] }, "ignoring malformed manifest capability entry"],
    [{ disabled: "nope" }, "manifest.disabled is not an array"],
    [{ disabled: [42] }, "ignoring malformed manifest disabled entry"],
  ])("warns and ignores a malformed manifest field %j", async (field, warned) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeManifest(field);
    expect(await capabilitiesGate.get("filesystem.read", "default")).not.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes(warned))).toBe(true);
    warn.mockRestore();
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

describe("§21 summary sanitization", () => {
  it("caps a manifest summary at 300 characters", () => {
    const merged = mergeManifest([], { capabilities: [{ id: "x.cap", domain: "memory", summary: "a".repeat(400) }] });
    expect(merged[0].summary).toHaveLength(300);
  });

  it("strips control and newline characters so a summary stays one line", () => {
    const merged = mergeManifest([], { capabilities: [{ id: "x.cap", domain: "memory", summary: "hello\nworld\r\x00" }] });
    expect(merged[0].summary).toBe("hello world");
  });

  it("falls back to the id when the summary is not a string", () => {
    const merged = mergeManifest([], {
      capabilities: [{ id: "x.cap", domain: "memory", summary: 42 as unknown as string }],
    });
    expect(merged[0].summary).toBe("x.cap");
  });
});
