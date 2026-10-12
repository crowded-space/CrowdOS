// create_artifact with no DATABASE_URL: the verb writes vfs/artifacts files
// and serves the local index — never the "DATABASE_URL is not set" failure.
// Gate-level round-trip plus the exact tool-dispatch path from the report.
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { artifactsGate } from "./artifacts-gate.js";
import { localUpsertAgent } from "../agents/agent-local-store.js";
import { ToolExecutor } from "../tools/tool-executor.js";

const WS = "ws-local-artifacts";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-artifacts-local-"));
  setLocalStoreDirForTests(dir);
  setRegistryFilePathForTests(join(dir, "workspaces.json"));
  const { saveWorkspaceRecord } = await import("../workspace/workspace-gate.js");
  const now = new Date().toISOString();
  await saveWorkspaceRecord({
    id: WS,
    name: WS,
    icon: "box",
    databaseUrl: "",
    rootPath: join(dir, WS),
    screenLockPinHash: null,
    createdAt: now,
    updatedAt: now,
  });
  return () => {
    setLocalStoreDirForTests(null);
    setRegistryFilePathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("create_artifact without DATABASE_URL (local mode)", () => {
  it("writes the body under vfs/artifacts and returns a file-backed row", async () => {
    const row = await artifactsGate.create({
      workspaceId: WS,
      producerAgent: "agent-1",
      runId: "run-local-1",
      type: "report",
      contentRef: "# Channel Summary",
      semanticTags: ["channel-summary"],
      metadata: {},
    });

    expect(row.id).toMatch(/^art_/);
    expect(row.path).toMatch(/^vfs\/artifacts\/run-local-1\/art_.*\.md$/);
    const abs = join(dir, WS, row.path!);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("# Channel Summary");
  });

  it("round-trips get/list through the local index with DB listing parity", async () => {
    const body = "x".repeat(600);
    const created = await artifactsGate.create({
      workspaceId: WS,
      producerAgent: "agent-1",
      runId: "run-local-1",
      type: "report",
      contentRef: body,
      semanticTags: [],
      metadata: {},
    });

    // getById serves the full body.
    const got = await artifactsGate.getById(created.id);
    expect(got?.id).toBe(created.id);
    expect(got?.contentRef).toBe(body);

    // Listings truncate blobs at 500 chars, like the DB projection.
    const byWs = await artifactsGate.listByWorkspace(WS);
    expect(byWs.map((r) => r.id)).toContain(created.id);
    expect(byWs.find((r) => r.id === created.id)?.contentRef).toHaveLength(500);

    const byRun = await artifactsGate.listByRun("run-local-1");
    expect(byRun.map((r) => r.id)).toContain(created.id);
  });

  it("dispatches the create_artifact tool end to end with no database", async () => {
    await localUpsertAgent({
      id: "agent-local-art",
      workspaceId: WS,
      name: "local-art",
      title: "Local Art",
      authorityLevel: 1,
      modelModuleId: null,
      instructionModuleId: "instr-default",
      memorySharingPolicy: "full",
      status: "idle",
      isTemplate: false,
    });

    const result = await ToolExecutor.execute(
      "agent-local-art",
      "create_artifact",
      { type: "report", content: "# Channel Summary" },
      { workspaceId: WS },
    );

    expect(String(result.error ?? "")).not.toContain("DATABASE_URL");
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.artifactId).toMatch(/^art_/);
    expect(payload.path).toMatch(/^vfs\/artifacts\/unscoped\//);
    expect(existsSync(join(dir, WS, payload.path))).toBe(true);
  });
});
