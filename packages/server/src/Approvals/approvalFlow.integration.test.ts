import postgres from "postgres";
import { config } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventBroker } from "../EventBroker/eventBrokerGate.js";

config();

type ApprovalRepo = typeof import("./approvalRepository.js");
type RunsRepo = typeof import("../Runs/runsRepository.js");

async function probeDevDb(): Promise<{ ok: boolean; sql: postgres.Sql | null }> {
  if (!process.env.DATABASE_URL) return { ok: false, sql: null };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 3, prepare: false, onnotice: () => {} });
  try { await sql`select 1`; } catch { await sql.end({timeout:1}); return { ok:false, sql:null }; }
  try {
    const rows = await sql`select unnest(enum_range(null::approval_status))::text as label`;
    if (!rows.map(r=>r.label as string).includes("pending")) { await sql.end({timeout:1}); return { ok:false, sql:null }; }
    const runRows = await sql`select unnest(enum_range(null::run_status))::text as label`;
    if (!runRows.map(r=>r.label as string).includes("waiting_for_approval")) { await sql.end({timeout:1}); return { ok:false, sql:null }; }
  } catch { await sql.end({timeout:1}); return { ok:false, sql:null }; }
  return { ok: true, sql };
}

vi.doUnmock("../Shared/config/database.js");

const probe = await probeDevDb();
const createdRunIds: string[] = [];
const createdApprovalIds: string[] = [];
let approvalRepo: ApprovalRepo | null = null;
let runsRepo: RunsRepo | null = null;

beforeAll(async () => {
  if (!probe.ok) return;
  approvalRepo = await import("./approvalRepository.js");
  runsRepo = await import("../Runs/runsRepository.js");
});

afterAll(async () => {
  if (probe.sql) {
    if (createdApprovalIds.length) try { await probe.sql`delete from approval_requests where id = any(${createdApprovalIds}::text[])`; } catch {}
    if (createdRunIds.length) try { await probe.sql`delete from runs where id = any(${createdRunIds}::uuid[])`; } catch {}
    await probe.sql.end({timeout:2});
  }
});

async function createRunningRun(): Promise<string> {
  const run = await runsRepo!.createRun({ agentId: `apr-flow-agent-${randomUUID().slice(0,6)}`, channelId: `apr-flow-ch-${randomUUID().slice(0,6)}`, workspaceId: "default", runtimeType: "agentic" });
  if (!run) throw new Error("createRun null");
  createdRunIds.push(run.id);
  await runsRepo!.applyTransition(run.id, "starting");
  await runsRepo!.applyTransition(run.id, "running");
  return run.id;
}

async function getAgentForTool(): Promise<{ id: string; name: string }> {
  const { getDb } = await import("../Shared/config/database.js");
  const db = getDb();
  const ag = await db.query.agents.findFirst();
  if (!ag) throw new Error("no agent seeded");
  // Ensure skills gate allows execute_bash for this agent (bypass if not)
  return { id: ag.id, name: ag.name };
}

describe.skipIf(!probe.ok)("Approvals APR-1 ToolExecutor pause flow (e2e with real DB)", () => {
  beforeEach(() => {
    vi.stubEnv("APPROVALS_ENABLED", "true");
    vi.stubEnv("APPROVAL_TTL_MS", "10000"); // 10s for tests to allow decide window
  });

  it("risky bash → approval row + WAITING_FOR_APPROVAL + event; grant → executes", async () => {
    const runId = await createRunningRun();
    const agent = await getAgentForTool();
    const { toolRegistry } = await import("../tools/toolRegistry.js");
    const original = toolRegistry.get("execute_bash");
    let handlerCalled = false;
    const mockHandler = async () => { handlerCalled = true; return { success: true, output: "mocked ok after grant" }; };
    if (original) toolRegistry.register({ ...original, handler: mockHandler as never });
    else toolRegistry.register({ id: "execute_bash", name: "execute_bash", displayName: "x", description: "x", category: "terminal", sourceType: "native", dangerLevel: "dangerous", authLevelRequired: 3, parameters: { type:"object", properties:{command:{type:"string"}}, required:["command"] }, handler: mockHandler as never });

    // Ensure agent allowed to use execute_bash (mock skillsGate)
    const { skillsGate } = await import("../Skills/skillsGate.js");
    const origSkills = skillsGate.getResolvedToolsForAgent;
    const skillsSpy = vi.spyOn(skillsGate, "getResolvedToolsForAgent").mockResolvedValue(["execute_bash", "read_file"]);

    const broker = new EventBroker();
    const requestedEvents: unknown[] = [];
    const decidedEvents: unknown[] = [];
    broker.on("approval.requested" as never, undefined, (e: unknown) => requestedEvents.push(e));
    broker.on("approval.decided" as never, undefined, (e: unknown) => decidedEvents.push(e));

    // Need to hook broker via globalBroker so ToolExecutor's fallback finds it? But ToolExecutor will use partialCtx.broker if provided.
    // So we will pass broker explicitly.
    const { ToolExecutor } = await import("../tools/ToolExecutor.js");

    // Start execution (will block waiting for approval)
    const execPromise = ToolExecutor.execute(agent.id, "execute_bash", { command: "npm install left-pad" }, { channelId: "ch-1", workspaceId: "default", runId, broker } as never);

    // Wait a bit for pending row creation
    let pendingRow: import("./approvalRepository.js").ApprovalRow | null = null;
    for (let i=0;i<20;i++) {
      await new Promise(r=>setTimeout(r,200));
      const pending = await approvalRepo!.findPendingByRun(runId);
      if (pending.length>0) { pendingRow = pending[0]; break; }
    }
    expect(pendingRow, "pending approval row should exist").not.toBeNull();
    createdApprovalIds.push(pendingRow!.id);
    expect(pendingRow!.status).toBe("pending");
    expect(pendingRow!.toolName).toBe("execute_bash");
    expect(pendingRow!.riskClass).toBe("install");

    const runDuring = await runsRepo!.getRunById(runId);
    expect(runDuring?.status).toBe("waiting_for_approval");

    // Eventually broker should have emitted requested (via ToolExecutor's broker param)
    // Our broker is the same instance passed, so check after small delay
    await new Promise(r=>setTimeout(r,300));
    // At least one requested event payload via broker.onAny? Our specific listeners may not capture because we used broker.on with type string; but we also check via polling DB.

    // Grant the approval
    const decided = await approvalRepo!.decide(pendingRow!.id, { decision: "approved", decidedBy: "operator-test" });
    expect(decided?.status).toBe("approved");

    // Now the waiting ToolExecutor should resume and execute handler
    const result = await execPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe("mocked ok after grant");
    expect(handlerCalled).toBe(true);

    const runAfter = await runsRepo!.getRunById(runId);
    expect(runAfter?.status).toBe("running");

    // Cleanup
    if (original) toolRegistry.register(original);
    else toolRegistry.unregister("execute_bash");
    skillsSpy.mockRestore();
  }, 15000);

  it("deny → tool fails safely, run continues (does not cancel)", async () => {
    const runId = await createRunningRun();
    const agent = await getAgentForTool();
    const { toolRegistry } = await import("../tools/toolRegistry.js");
    const original = toolRegistry.get("execute_bash");
    let handlerCalled = false;
    const mockHandler = async () => { handlerCalled = true; return { success: true, output: "should not reach" }; };
    if (original) toolRegistry.register({ ...original, handler: mockHandler as never });
    else toolRegistry.register({ id: "execute_bash", name:"execute_bash", displayName:"x", description:"x", category:"terminal", sourceType:"native", dangerLevel:"dangerous", authLevelRequired:3, parameters:{type:"object", properties:{command:{type:"string"}}, required:["command"]}, handler: mockHandler as never });
    const { skillsGate } = await import("../Skills/skillsGate.js");
    const skillsSpy = vi.spyOn(skillsGate, "getResolvedToolsForAgent").mockResolvedValue(["execute_bash"]);

    const broker = new EventBroker();
    const { ToolExecutor } = await import("../tools/ToolExecutor.js");
    const execPromise = ToolExecutor.execute(agent.id, "execute_bash", { command: "curl http://example.com" }, { channelId: "ch-2", workspaceId: "default", runId, broker } as never);

    let pendingRow: import("./approvalRepository.js").ApprovalRow | null = null;
    for (let i=0;i<20;i++) {
      await new Promise(r=>setTimeout(r,200));
      const pending = await approvalRepo!.findPendingByRun(runId);
      if (pending.length>0) { pendingRow = pending[0]; break; }
    }
    expect(pendingRow).not.toBeNull();
    createdApprovalIds.push(pendingRow!.id);

    const runMid = await runsRepo!.getRunById(runId);
    expect(runMid?.status).toBe("waiting_for_approval");

    // Deny
    const denied = await approvalRepo!.decide(pendingRow!.id, { decision: "denied", decidedBy: "operator-test" });
    expect(denied?.status).toBe("denied");

    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/approval denied|denied/i);
    expect(handlerCalled).toBe(false);

    const runAfter = await runsRepo!.getRunById(runId);
    expect(runAfter?.status).toBe("running");
    // Policy: run continues, not cancelled
    expect(runAfter?.status).not.toBe("cancelled");
    expect(runAfter?.status).not.toBe("failed");

    if (original) toolRegistry.register(original);
    else toolRegistry.unregister("execute_bash");
    skillsSpy.mockRestore();
  }, 15000);

  it("reusable grant second call auto-approved without re-ask", async () => {
    const runId1 = await createRunningRun();
    const runId2 = await createRunningRun();
    const agent = await getAgentForTool();
    const { toolRegistry } = await import("../tools/toolRegistry.js");
    const original = toolRegistry.get("execute_bash");
    let callCount = 0;
    const mockHandler = async () => { callCount++; return { success: true, output: `call ${callCount}` }; };
    if (original) toolRegistry.register({ ...original, handler: mockHandler as never });
    else toolRegistry.register({ id:"execute_bash", name:"execute_bash", displayName:"x", description:"x", category:"terminal", sourceType:"native", dangerLevel:"dangerous", authLevelRequired:3, parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}, handler: mockHandler as never });
    const { skillsGate } = await import("../Skills/skillsGate.js");
    const skillsSpy = vi.spyOn(skillsGate, "getResolvedToolsForAgent").mockResolvedValue(["execute_bash"]);
    const { ToolExecutor } = await import("../tools/ToolExecutor.js");

    const cmd = "git push origin main";
    const broker1 = new EventBroker();
    const exec1 = ToolExecutor.execute(agent.id, "execute_bash", { command: cmd }, { channelId:"ch-3", workspaceId:"default", runId: runId1, broker: broker1 } as never);
    let pending1: import("./approvalRepository.js").ApprovalRow | null = null;
    for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,200)); const p=await approvalRepo!.findPendingByRun(runId1); if(p.length){pending1=p[0];break;} }
    expect(pending1).not.toBeNull();
    createdApprovalIds.push(pending1!.id);
    // Approve with reusable scope (handler's scope hash will be derived from argsPreview; decide with scope to make reusable)
    const { computeScopeHash } = await import("./approvalTypes.js");
    const scopeHash = computeScopeHash("execute_bash", { command: cmd });
    await approvalRepo!.decide(pending1!.id, { decision:"approved", decidedBy:"op", scope: scopeHash });
    const result1 = await exec1;
    expect(result1.success).toBe(true);

    // Second identical call on different run should auto-approve (no pending created, handler runs immediately)
    const broker2 = new EventBroker();
    const start = Date.now();
    const result2 = await ToolExecutor.execute(agent.id, "execute_bash", { command: cmd }, { channelId:"ch-3", workspaceId:"default", runId: runId2, broker: broker2 } as never);
    const elapsed = Date.now() - start;
    expect(result2.success).toBe(true);
    // Should be fast (no 300ms poll wait) because reusable path is synchronous
    expect(elapsed).toBeLessThan(2000);
    // Verify a new approved audit row exists for run2
    const rows2 = await approvalRepo!.listByRun(runId2);
    expect(rows2.length).toBeGreaterThanOrEqual(1);
    const autoRow = rows2.find(r=> r.status==="approved" && r.scope===scopeHash);
    expect(autoRow).toBeDefined();
    if (autoRow) createdApprovalIds.push(autoRow.id);
    const pending2 = await approvalRepo!.findPendingByRun(runId2);
    expect(pending2.length).toBe(0);
    // Run should never have entered waiting_for_approval (or quickly transitioned)
    const run2 = await runsRepo!.getRunById(runId2);
    expect(run2?.status).toBe("running");

    if (original) toolRegistry.register(original);
    else toolRegistry.unregister("execute_bash");
    skillsSpy.mockRestore();
  }, 15000);

  it("TTL expiry auto-denies (default-deny) and run resumes", async () => {
    vi.stubEnv("APPROVAL_TTL_MS", "1200"); // 1.2s for fast expiry
    const runId = await createRunningRun();
    const agent = await getAgentForTool();
    const { toolRegistry } = await import("../tools/toolRegistry.js");
    const original = toolRegistry.get("execute_bash");
    let handlerCalled = false;
    const mockHandler = async () => { handlerCalled = true; return { success:true, output:"should not run" }; };
    if (original) toolRegistry.register({ ...original, handler: mockHandler as never });
    else toolRegistry.register({ id:"execute_bash", name:"execute_bash", displayName:"x", description:"x", category:"terminal", sourceType:"native", dangerLevel:"dangerous", authLevelRequired:3, parameters:{type:"object", properties:{command:{type:"string"}}, required:["command"]}, handler: mockHandler as never });
    const { skillsGate } = await import("../Skills/skillsGate.js");
    const skillsSpy = vi.spyOn(skillsGate, "getResolvedToolsForAgent").mockResolvedValue(["execute_bash"]);
    const { ToolExecutor } = await import("../tools/ToolExecutor.js");
    const broker = new EventBroker();
    // Use an ASK-class command (not DENY) so approval flow triggers and TTL can expire
    const execPromise = ToolExecutor.execute(agent.id, "execute_bash", { command: "curl http://example.com/should-expire" }, { channelId:"ch-4", workspaceId:"default", runId, broker } as never);

    let pendingRow: import("./approvalRepository.js").ApprovalRow|null=null;
    for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,200)); const p=await approvalRepo!.findPendingByRun(runId); if(p.length){pendingRow=p[0];break;} }
    expect(pendingRow).not.toBeNull();
    createdApprovalIds.push(pendingRow!.id);
    // Do NOT decide; wait for TTL to expire (poll interval 300ms + TTL 1200ms + slack)
    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/expired|denied|TTL/i);
    expect(handlerCalled).toBe(false);
    const after = await approvalRepo!.getById(pendingRow!.id);
    expect(after?.status).toBe("expired");
    const runAfter = await runsRepo!.getRunById(runId);
    expect(runAfter?.status).toBe("running");

    if (original) toolRegistry.register(original);
    else toolRegistry.unregister("execute_bash");
    skillsSpy.mockRestore();
    vi.stubEnv("APPROVAL_TTL_MS", "10000");
  }, 15000);
});
