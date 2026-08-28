import postgres from "postgres";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";

config();

vi.doUnmock("../Shared/config/database.js");

async function probeDb(): Promise<{ ok: boolean; sql: postgres.Sql | null }> {
  if (!process.env.DATABASE_URL) {
    console.warn("[artifactsGate.test] DATABASE_URL missing; skipping");
    return { ok: false, sql: null };
  }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 3, prepare: false, onnotice: () => {} });
  try { await sql`select 1`; } catch (e) {
    console.warn(`[artifactsGate.test] DB unreachable: ${e instanceof Error ? e.message : String(e)}`);
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }
  try {
    const rows = await sql`select unnest(enum_range(null::artifact_type))::text as v`;
    const vals = rows.map((r: any) => r.v as string);
    if (!vals.includes("diff") || !vals.includes("file")) {
      console.warn("[artifactsGate.test] artifact_type enum missing file/diff; skipping");
      await sql.end({ timeout: 1 });
      return { ok: false, sql: null };
    }
  } catch {
    console.warn("[artifactsGate.test] artifact_type enum missing");
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }
  return { ok: true, sql };
}

const probe = await probeDb();
const createdArtifactIds: string[] = [];
const createdRunIds: string[] = [];
let gate: typeof import("./artifactsGate.js").artifactsGate | null = null;
let runsRepo: typeof import("../Runs/runsRepository.js") | null = null;

beforeAll(async () => {
  if (!probe.ok) return;
  const mod = await import("./artifactsGate.js");
  gate = mod.artifactsGate;
  runsRepo = await import("../Runs/runsRepository.js");
});

afterAll(async () => {
  if (probe.sql) {
    try {
      if (createdArtifactIds.length > 0) {
        await probe.sql`delete from artifacts where id = any(${createdArtifactIds})`;
      }
      if (createdRunIds.length > 0) {
        await probe.sql`delete from runs where id = any(${createdRunIds}::uuid[])`;
      }
    } catch (e) { console.warn("[artifactsGate.test] cleanup failed", e); }
    await probe.sql.end({ timeout: 2 });
  }
});

describe.skipIf(!probe.ok)("Artifacts gate — repository CRUD (ART-1)", () => {
  it("creates diff artifact for a run and listByRun returns it", async () => {
    const { sql } = probe;
    // ensure workspace exists for FK
    const wsId = `ws_art_${randomUUID().slice(0, 6)}`;
    const wsRoot = path.join(os.tmpdir(), wsId).replace(/\\/g, "/");
    await sql!.unsafe(`insert into workspaces (id, name, owner_id, status, root_path, permissions, constraints, metadata, created_at, updated_at) values ('${wsId}', 'art-test', 'tester', 'ACTIVE', '${wsRoot}', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now()) on conflict (id) do nothing`);
    const run = await runsRepo!.createRun({ agentId: "art-agent-1", channelId: "art-channel-1", workspaceId: wsId, runtimeType: "coding" });
    expect(run).not.toBeNull();
    createdRunIds.push(run!.id);
    const before = "line1\nline2\n";
    const after = "line1\nline2 modified\n";
    const beforeHash = createHash("sha256").update(before).digest("hex");
    const afterHash = createHash("sha256").update(after).digest("hex");
    const art = await gate!.create({
      runId: run!.id,
      workspaceId: wsId,
      producerAgent: "art-agent-1",
      type: "diff",
      path: "src/example.ts",
      beforeHash,
      afterHash,
      patch: "--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-line2\n+line2 modified\n",
      contentRef: after,
    });
    expect(art).toBeDefined();
    expect(art.artifactType).toBe("diff");
    expect(art.beforeHash).toBe(beforeHash);
    expect(art.afterHash).toBe(afterHash);
    expect(art.patch).toContain("line2");
    createdArtifactIds.push(art.id);
    const listed = await gate!.listByRun(run!.id);
    expect(listed.find((r) => r.id === art.id)).toBeDefined();
    expect(listed.length).toBeGreaterThanOrEqual(1);
    await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
  });

  it("creates file type variant", async () => {
    const { sql } = probe;
    const wsId = `ws_art_${randomUUID().slice(0, 6)}`;
    const wsRoot = path.join(os.tmpdir(), wsId).replace(/\\/g, "/");
    await sql!.unsafe(`insert into workspaces (id, name, owner_id, status, root_path, permissions, constraints, metadata, created_at, updated_at) values ('${wsId}', 'art-test2', 'tester', 'ACTIVE', '${wsRoot}', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now()) on conflict (id) do nothing`);
    const run = await runsRepo!.createRun({ agentId: "art-agent-2", channelId: "art-channel-2", workspaceId: wsId, runtimeType: "coding" });
    expect(run).not.toBeNull();
    createdRunIds.push(run!.id);
    const content = "hello world\n";
    const afterHash = createHash("sha256").update(content).digest("hex");
    const art = await gate!.create({
      runId: run!.id,
      workspaceId: wsId,
      producerAgent: "art-agent-2",
      type: "file",
      path: "src/newfile.ts",
      beforeHash: null,
      afterHash,
      patch: null,
      contentRef: content,
    });
    expect(art.artifactType).toBe("file");
    expect(art.beforeHash).toBeNull();
    createdArtifactIds.push(art.id);
    const fetched = await gate!.getById(art.id);
    expect(fetched?.id).toBe(art.id);
    const wsListed = await gate!.listByWorkspace(wsId);
    expect(wsListed.find((r) => r.id === art.id)).toBeDefined();
    await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
  });

  it("supports report and citations types for future producers", async () => {
    const { sql } = probe;
    const wsId = `ws_art_${randomUUID().slice(0, 6)}`;
    const wsRoot = path.join(os.tmpdir(), wsId).replace(/\\/g, "/");
    await sql!.unsafe(`insert into workspaces (id, name, owner_id, status, root_path, permissions, constraints, metadata, created_at, updated_at) values ('${wsId}', 'art-test3', 'tester', 'ACTIVE', '${wsRoot}', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now()) on conflict (id) do nothing`);
    const run = await runsRepo!.createRun({ agentId: "art-agent-3", channelId: "art-channel-3", workspaceId: wsId, runtimeType: "research" });
    expect(run).not.toBeNull();
    createdRunIds.push(run!.id);
    for (const t of ["report", "citations"] as const) {
      const art = await gate!.create({
        runId: run!.id,
        workspaceId: wsId,
        producerAgent: "art-agent-3",
        type: t,
        path: null,
        beforeHash: null,
        afterHash: null,
        patch: null,
        contentRef: `dummy ${t} content`,
      });
      expect(art.artifactType).toBe(t);
      createdArtifactIds.push(art.id);
    }
    const listed = await gate!.listByRun(run!.id);
    expect(listed.length).toBe(2);
    await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
  });
});

describe.skipIf(!probe.ok)("Artifacts gate — coding run integration (ART-1)", () => {
  it("coding file edit via CodingRuntime yields diff artifact rows with patch/hashes", async () => {
    const { sql } = probe;
    const wsId = `ws_code_${randomUUID().slice(0, 6)}`;
    const wsRoot = path.join(os.tmpdir(), wsId).replace(/\\/g, "/");
    await fs.mkdir(wsRoot, { recursive: true });
    await sql!.unsafe(`insert into workspaces (id, name, owner_id, status, root_path, permissions, constraints, metadata, created_at, updated_at) values ('${wsId}', 'code-test', 'tester', 'ACTIVE', '${wsRoot}', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now()) on conflict (id) do nothing`);
    // seed required channel and agent for RuntimeExecutor? We'll test CodingRuntime directly.
    const db = (await import("../Shared/config/database.js")).getDb();
    let channel = await db.query.channels.findFirst();
    let agent = await db.query.agents.findFirst();
    if (!channel) {
      console.warn("[artifactsGate.test] no channel seeded; skipping coding integration");
      await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
      return;
    }
    if (!agent) {
      console.warn("[artifactsGate.test] no agent seeded; skipping");
      await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
      return;
    }
    // Ensure workspace dir for Guard
    process.env.WORKSPACE_DIR = wsRoot;
    const testFile = path.join(wsRoot, "src", "sample.ts");
    await fs.mkdir(path.dirname(testFile), { recursive: true });
    const original = "export const greeting = \"hi\";\n";
    await fs.writeFile(testFile, original, "utf8");
    const edited = "export const greeting = \"hello\";\n";
    const expectedAfterHash = createHash("sha256").update(edited).digest("hex");
    const expectedBeforeHash = createHash("sha256").update(original).digest("hex");

    const { CodingRuntime } = await import("../runtime/runtimes/CodingRuntime.js");
    const { ProviderRegistry } = await import("../runtime/providers/ProviderRegistry.js");
    const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
    const { runsGate } = await import("../Runs/runsGate.js");

    // Create a run row to attach artifacts to
    const run = await runsRepo!.createRun({ agentId: agent.id, channelId: channel.id, workspaceId: wsId, runtimeType: "coding" });
    if (!run) {
      console.warn("[artifactsGate.test] run creation disabled (RUNS_ENABLED false)");
      await sql!.unsafe(`delete from workspaces where id='${wsId}'`);
      return;
    }
    createdRunIds.push(run.id);
    // Transition to running so gate sees it? Not required for artifacts but to mimic real flow
    await runsRepo!.applyTransition(run.id, "starting");
    await runsRepo!.applyTransition(run.id, "running");

    let callCount = 0;
    const mockProvider: any = {
      provider: "custom-artifact-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(_config: any, _req: any, onChunk: any) {
        callCount++;
        if (callCount === 1) {
          onChunk?.({ isThoughts: false, content: "editing file" });
          return {
            content: "editing",
            toolCalls: [{ id: "call_art_1", name: "edit_file", input: { path: "src/sample.ts", targetContent: "\"hi\"", replacementContent: "\"hello\"" } }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            finishReason: "tool_use" as const,
          };
        }
        onChunk?.({ isThoughts: false, content: "done" });
        return { content: "done", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, finishReason: "stop" as const };
      },
    };
    ProviderRegistry.register(mockProvider);
    const broker = new EventBroker();
    const runtime = new CodingRuntime();
    const packet: any = {
      requestId: `req-art-${randomUUID().slice(0, 6)}`,
      agentId: agent.id,
      agentName: agent.name,
      authorityLevel: agent.authorityLevel ?? 3,
      channelId: channel.id,
      workspaceId: wsId,
      systemPrompt: "you are coding agent",
      userInput: "please edit src/sample.ts",
      history: [],
      policies: { maxTokenBudget: 4000, maxIterations: 5, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: true, streamOutput: true },
      metadata: { runtimeType: "coding", provider: "custom-artifact-test", modelName: "test", modelModuleId: "mod-01", startedAt: new Date() },
      runId: run.id,
      _modelConfig: { provider: "custom-artifact-test", modelName: "test", temperature: 0.1, maxOutputTokens: 2048 },
    };
    const result = await runtime.execute(packet, broker);
    expect(result.status).toBe("completed");
    expect(callCount).toBe(2);
    // Verify file was actually edited
    const finalOnDisk = await fs.readFile(testFile, "utf8");
    expect(finalOnDisk).toBe(edited);
    // Verify artifact row
    const arts = await gate!.listByRun(run.id);
    expect(arts.length).toBeGreaterThanOrEqual(1);
    const diffArt = arts.find((a) => a.path === "src/sample.ts");
    expect(diffArt).toBeDefined();
    expect(diffArt!.artifactType).toBe("diff");
    expect(diffArt!.beforeHash).toBe(expectedBeforeHash);
    expect(diffArt!.afterHash).toBe(expectedAfterHash);
    expect(diffArt!.patch).toBeTruthy();
    expect(diffArt!.patch!.length).toBeGreaterThan(10);
    expect(diffArt!.contentRef).toContain("hello");
    createdArtifactIds.push(...arts.map((a) => a.id));
    // Also test write_file variant creates file artifact
    const wsId2 = `ws_code2_${randomUUID().slice(0, 6)}`;
    const wsRoot2 = path.join(os.tmpdir(), wsId2).replace(/\\/g, "/");
    await fs.mkdir(wsRoot2, { recursive: true });
    await sql!.unsafe(`insert into workspaces (id, name, owner_id, status, root_path, permissions, constraints, metadata, created_at, updated_at) values ('${wsId2}', 'code-test2', 'tester', 'ACTIVE', '${wsRoot2}', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now()) on conflict (id) do nothing`);
    const run2 = await runsRepo!.createRun({ agentId: agent.id, channelId: channel.id, workspaceId: wsId2, runtimeType: "coding" });
    createdRunIds.push(run2!.id);
    await runsRepo!.applyTransition(run2!.id, "starting");
    await runsRepo!.applyTransition(run2!.id, "running");
    let wc = 0;
    const mockWriteProvider: any = {
      provider: "custom-artifact-write-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(_c: any, _r: any, onChunk: any) {
        wc++;
        if (wc === 1) {
          return { content: "writing", toolCalls: [{ id: "call_w_1", name: "write_file", input: { path: "src/newfile.ts", content: "export const x=1\n" } }], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, finishReason: "tool_use" as const };
        }
        return { content: "done writed", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, finishReason: "stop" as const };
      },
    };
    ProviderRegistry.register(mockWriteProvider);
    const packet2: any = { ...packet, workspaceId: wsId2, runId: run2!.id, requestId: `req-art2-${randomUUID().slice(0,6)}`, _modelConfig: { provider: "custom-artifact-write-test", modelName: "test", temperature: 0.1, maxOutputTokens: 2048 } };
    const result2 = await runtime.execute(packet2, broker);
    expect(result2.status).toBe("completed");
    const arts2 = await gate!.listByRun(run2!.id);
    expect(arts2.length).toBeGreaterThanOrEqual(1);
    expect(arts2[0].artifactType).toBe("file");
    expect(arts2[0].afterHash).toBeTruthy();
    createdArtifactIds.push(...arts2.map((a) => a.id));
    // Cleanup workspaces
    await fs.rm(wsRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(wsRoot2, { recursive: true, force: true }).catch(() => {});
    await sql!.unsafe(`delete from workspaces where id in ('${wsId}','${wsId2}')`);
    delete process.env.WORKSPACE_DIR;
  });
});
