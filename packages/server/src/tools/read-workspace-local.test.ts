// ─── read_workspace_local — the Zone A door, L0-only ──────────────────
// Pins the ONE tool that reaches the Workspace Local zone (§15 / decision D4).
// Its authority boundary is the entire reason it exists, so the REJECT path is
// asserted as carefully as the accept path: a tool that hands Zone A contents to
// an L1 agent is worse than no tool at all.
//
// The executor level gate is `agent.authorityLevel > authLevelRequired`, so
// `authLevelRequired: 0` is L0-only — but ONLY for a non-omniscient agent, since
// `!agent.isOmniscient` escapes the check. The reject case below therefore uses
// `isOmniscient: false`; asserting L0-only with an omniscient agent would pass
// while proving nothing.
//
// Note this suite deliberately does NOT cover read_file / list_directory. Those
// resolve through resolveToolRoot() to the channel EFFECTIVE root (Zone B), and
// that panel/tool agreement is already pinned in channel-mount-gate.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const agentRow = vi.hoisted(() => ({
  id: "agent-l0",
  name: "probe-agent",
  authorityLevel: 0,
  isOmniscient: false,
}));

vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: { getResolvedToolsForAgent: async () => ["read_workspace_local"] },
}));

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({ query: { agents: { findFirst: async () => ({ ...agentRow }) } } }),
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
  isDatabaseConfigured: () => true,
}));

import { ToolExecutor, classifyToolEffect } from "./tool-executor.js";
import { toolRegistry } from "./tool-registry.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "crowdos-zonea-"));
const ZONE_A = join(TEST_ROOT, "default");
const savedWorkspaceDir = process.env.WORKSPACE_DIR;

/** Case/separator-insensitive compare — Windows tmp paths can differ in case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function seedZoneA(): void {
  mkdirSync(join(ZONE_A, "src"), { recursive: true });
  mkdirSync(join(ZONE_A, ".crowdos"), { recursive: true });
  writeFileSync(join(ZONE_A, "notes.txt"), "zone-a note", "utf8");
  writeFileSync(join(ZONE_A, ".crowdosrc"), "{}", "utf8");
  writeFileSync(join(ZONE_A, ".ThisCrowd"), "{}", "utf8");
  writeFileSync(join(ZONE_A, ".editor-cache"), "hidden", "utf8");
}

function listOf(result: { output: string }): { name: string; type: string }[] {
  return JSON.parse(result.output).entries;
}

describe("read_workspace_local · Zone A door", () => {
  beforeEach(() => {
    // Zone A base = WORKSPACE_DIR; workspace "default" has no registry record,
    // so resolveWorkspaceLocalRoot falls through to <sandboxBase>/<workspaceId>.
    process.env.WORKSPACE_DIR = TEST_ROOT;
    agentRow.authorityLevel = 0;
    agentRow.isOmniscient = false;
    rmSync(ZONE_A, { recursive: true, force: true });
    seedZoneA();
  });

  afterEach(() => {
    if (savedWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = savedWorkspaceDir;
  });

  afterAll(() => {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  it("registers as a read-classified L0 tool (no executor name-map entry needed)", () => {
    const def = toolRegistry.get("read_workspace_local");
    expect(def).toBeDefined();
    expect(def!.authLevelRequired).toBe(0);
    expect(def!.effectClass).toBe("read");
    // classifyToolEffect prefers the definition, so PERF-8 batches it with reads
    // instead of defaulting it to the conservative "write" bucket.
    expect(classifyToolEffect("read_workspace_local", def)).toBe("read");
  });

  it("L0 (non-omniscient) lists Zone A, hiding ordinary dotfiles but not repo markers", async () => {
    const result = await ToolExecutor.execute(
      "agent-l0",
      "read_workspace_local",
      {},
      { workspaceId: "default" },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.zone).toBe("workspace-local");
    expect(samePath(payload.root, ZONE_A)).toBe(true);

    const entries = listOf(result);
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("notes.txt");
    // Repo markers stay visible; an ordinary dotfile does not.
    expect(names).toContain(".crowdos");
    expect(names).toContain(".crowdosrc");
    expect(names).toContain(".ThisCrowd");
    expect(names).not.toContain(".editor-cache");

    // Directories first, then files — the tree renders this order directly.
    const firstFile = entries.findIndex((e) => e.type === "file");
    const lastDir = entries.map((e) => e.type).lastIndexOf("directory");
    expect(lastDir).toBeLessThan(firstFile);
  });

  it("reads a file inside Zone A", async () => {
    const result = await ToolExecutor.execute(
      "agent-l0",
      "read_workspace_local",
      { path: "notes.txt" },
      { workspaceId: "default" },
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).content).toBe("zone-a note");
  });

  it("L1 (non-omniscient) is refused, and nothing from Zone A is returned", async () => {
    agentRow.authorityLevel = 1;

    const result = await ToolExecutor.execute(
      "agent-l1",
      "read_workspace_local",
      {},
      { workspaceId: "default" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Security breach: Tool "read_workspace_local" requires Level 0 authority',
    );
    expect(result.error).toContain("@probe-agent is Level 1");
    // The refusal must not carry a payload — a rejected call that still returns
    // Zone A contents would leak through whatever reads `output`.
    expect(result.output).toBe("");
  });

  it("an absent Zone A fails loudly instead of reading a different directory", async () => {
    // Guard.getWorkspaceDir() falls back to WORKSPACE_DIR when the root it was
    // handed does not exist, so without the handler own existence check this call
    // would silently return the sandbox base as if it were the workspace.
    const result = await ToolExecutor.execute(
      "agent-l0",
      "read_workspace_local",
      {},
      { workspaceId: "no-such-workspace" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Workspace Local zone does not exist:");
    expect(result.output).toBe("");
  });

  it("refuses a path that escapes Zone A", async () => {
    const result = await ToolExecutor.execute(
      "agent-l0",
      "read_workspace_local",
      { path: "../outside.txt" },
      { workspaceId: "default" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Access Denied");
  });
});

