import postgres from "postgres";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

config();

type RunsRepo = typeof import("./runs-repository.js");
type GateMod = typeof import("./runs-gate.js");
type Gate = GateMod["runsGate"];

async function probeDb() {
  if (!process.env.DATABASE_URL) return { ok: false, sql: null as postgres.Sql | null };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 3, prepare: false, onnotice: () => {} });
  try { await sql`select 1`; } catch (e) {
    console.warn(`[resume.integration] DB unreachable ${String(e)}; skipping`);
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }
  try {
    const rows = await sql`select unnest(enum_range(null::run_status))::text as label`;
    const vals = rows.map((r: any) => r.label as string);
    if (!vals.includes("resumable")) {
      console.warn("[resume.integration] run_status missing resumable; skipping");
      await sql.end({ timeout: 1 });
      return { ok: false, sql: null };
    }
    const cols = await sql`select column_name from information_schema.columns where table_name='runs' and column_name='checkpoint'`;
    if (cols.length === 0) {
      console.warn("[resume.integration] checkpoint column missing; skipping");
      await sql.end({ timeout: 1 });
      return { ok: false, sql: null };
    }
    const tc = await sql`select tablename from pg_tables where schemaname='public' and tablename='runs_compensation'`;
    if (tc.length === 0) {
      console.warn("[resume.integration] runs_compensation missing; skipping");
      await sql.end({ timeout: 1 });
      return { ok: false, sql: null };
    }
  } catch {
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }
  return { ok: true, sql };
}

vi.doUnmock("../Shared/config/database.js");

const probe = await probeDb();
let repo: RunsRepo | null = null;
let gate: Gate | null = null;
const created: string[] = [];

beforeAll(async () => {
  if (!probe.ok) return;
  repo = await import("./runs-repository.js");
  const mod = await import("./runs-gate.js");
  gate = mod.runsGate as unknown as Gate;
});

afterAll(async () => {
  if (probe.sql && created.length > 0) {
    try { await probe.sql`delete from runs where id = any(${created}::uuid[])`; } catch {}
  }
  if (probe.sql) await probe.sql.end({ timeout: 2 });
});

describe.skipIf(!probe.ok)("RES-1 resume + checkpoint + compensation integration (real DB)", () => {
  it("checkpoint merge appends ids and updates watermark", async () => {
    const run = await repo!.createRun({ agentId: "res1-agent", channelId: "res1-channel", runtimeType: "agentic" });
    expect(run).not.toBeNull();
    created.push(run!.id);
    await repo!.touchCheckpoint(run!.id, { watermarkSeq: 5, completedCallIds: ["call-1"] });
    let fetched = await repo!.getRunById(run!.id);
    expect((fetched!.checkpoint as any).watermarkSeq).toBe(5);
    expect((fetched!.checkpoint as any).completedCallIds).toEqual(["call-1"]);
    await repo!.touchCheckpoint(run!.id, { watermarkSeq: 10, completedCallIds: ["call-2", "call-1"] });
    fetched = await repo!.getRunById(run!.id);
    expect((fetched!.checkpoint as any).watermarkSeq).toBe(10);
    expect((fetched!.checkpoint as any).completedCallIds).toEqual(["call-1", "call-2"]);
    expect(fetched!.checkpointSeq).toBe(10);
  });

  it("compensation journal records and undoes correctly", async () => {
    const run = await repo!.createRun({ agentId: "res1-agent", channelId: "res1-channel", runtimeType: "agentic" });
    created.push(run!.id);
    const inverse = repo!.buildCompensationInverse({ existed: true, priorContent: "prior content for undo", path: "/tmp/resume-test.txt" });
    const entry = await repo!.addCompensation(run!.id, { toolName: "write_file", targetPath: "/tmp/resume-test.txt", inverseOp: inverse });
    expect(entry).not.toBeNull();
    expect(entry!.seq).toBe(1);
    const list = await repo!.listCompensations(run!.id);
    expect(list.length).toBe(1);
    expect(list[0].inverseOp.op).toBe("restore");
    // add second
    const inv2 = repo!.buildCompensationInverse({ existed: false, priorContent: null, path: "/tmp/newfile.txt" });
    const e2 = await repo!.addCompensation(run!.id, { toolName: "write_file", targetPath: "/tmp/newfile.txt", inverseOp: inv2 });
    expect(e2!.seq).toBe(2);
    const list2 = await repo!.listCompensations(run!.id);
    expect(list2.length).toBe(2);
    expect(list2.map(r => r.seq)).toEqual([1, 2]);
  });

  it("orphan sweep flips running→orphaned→resumable and resume re-queues", async () => {
    const run = await repo!.createRun({ agentId: "res1-agent", channelId: "res1-channel", runtimeType: "agentic" });
    created.push(run!.id);
    // walk to running
    await repo!.applyTransition(run!.id, "starting");
    await repo!.applyTransition(run!.id, "running");
    // simulate staleness by backdating updated_at 10 minutes ago
    await probe.sql!.unsafe(`update runs set updated_at = now() - interval '10 minutes' where id = '${run!.id}'`);
    await repo!.touchCheckpoint(run!.id, { watermarkSeq: 2, completedCallIds: ["call-1", "call-2"] });
    // after touchCheckpoint, updated_at becomes now, so we need to backdate again
    await probe.sql!.unsafe(`update runs set updated_at = now() - interval '10 minutes' where id = '${run!.id}'`);
    // import sweeper
    const { sweepOrphanedRuns } = await import("./orphan-sweep.js");
    const { EventBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = new EventBroker();
    const swept = await sweepOrphanedRuns(broker);
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await repo!.getRunById(run!.id);
    expect(after!.status).toBe("resumable");
    expect((after!.checkpoint as any).completedCallIds).toEqual(["call-1", "call-2"]);
    // resume
    const res = await gate!.resumeRun(run!.id);
    expect(res).not.toBeNull();
    expect(res!.run.status).toBe("queued");
    expect(res!.checkpoint!.completedCallIds).toEqual(["call-1", "call-2"]);
    // second resume should fail
    const res2 = await gate!.resumeRun(run!.id);
    expect(res2).toBeNull();
  });

  it("resumeRun validates only resumable", async () => {
    const run = await repo!.createRun({ agentId: "res1-agent", channelId: "res1-channel", runtimeType: "agentic" });
    created.push(run!.id);
    await repo!.applyTransition(run!.id, "starting");
    const attempt = await gate!.resumeRun(run!.id);
    expect(attempt).toBeNull();
    const fetched = await repo!.getRunById(run!.id);
    expect(fetched!.status).toBe("starting");
  });
});
