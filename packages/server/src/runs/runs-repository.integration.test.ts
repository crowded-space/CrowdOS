import postgres from "postgres";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

config();

type RunsRepo = typeof import("./runs-repository.js");

interface DbProbe {
  ok: boolean;
  sql: postgres.Sql | null;
}

async function probeDevDb(): Promise<DbProbe> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[runsRepository.integration] DATABASE_URL is not set; skipping RUN-1 DB integration test"
    );
    return { ok: false, sql: null };
  }

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 3,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await sql`select 1`;
  } catch (err) {
    console.warn(
      `[runsRepository.integration] local dev DB unreachable (${err instanceof Error ? err.message : String(err)}); skipping RUN-1 DB integration test`
    );
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }

  try {
    const rows = await sql`select unnest(enum_range(null::run_status))::text as label`;
    const values = rows.map((row) => row.label as string);
    if (!values.includes("created")) {
      console.warn(
        "[runsRepository.integration] run_status enum not yet expanded in dev DB (missing 'created'); skipping until coordinator migration lands"
      );
      await sql.end({ timeout: 1 });
      return { ok: false, sql: null };
    }
  } catch {
    console.warn(
      "[runsRepository.integration] run_status enum type missing in dev DB; skipping until coordinator applies migrations"
    );
    await sql.end({ timeout: 1 });
    return { ok: false, sql: null };
  }

  return { ok: true, sql };
}

// The global test-setup replaces the database layer with an in-memory fake;
// this suite exercises the REAL repository against local dev Postgres.
vi.doUnmock("../Shared/config/database.js");

const probe = await probeDevDb();
const createdRunIds: string[] = [];
let repo: RunsRepo | null = null;

beforeAll(async () => {
  if (!probe.ok) return;
  repo = await import("./runs-repository.js");
});

afterAll(async () => {
  if (probe.sql && createdRunIds.length > 0) {
    try {
      await probe.sql`delete from runs where id = any(${createdRunIds}::uuid[])`;
    } catch (err) {
      console.warn("[runsRepository.integration] cleanup failed:", err);
    }
  }
  if (probe.sql) await probe.sql.end({ timeout: 2 });
});

describe.skipIf(!probe.ok)("runsRepository against local dev DB (RUN-1)", () => {
  it("logs a full durable transition chain created -> completed through the state machine", async () => {
    const run = await repo!.createRun({
      agentId: "run1-int-agent",
      channelId: "run1-int-channel",
      workspaceId: null,
      runtimeType: "agentic",
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe("created");
    createdRunIds.push(run!.id);

    const hops = ["starting", "running", "completing", "verifying", "completed"] as const;
    let previousUpdatedAt = run!.updatedAt;
    let previousStatus: string = run!.status;

    for (const [index, to] of hops.entries()) {
      if (to === "completing") {
        expect(await repo!.applyTransition(run!.id, "completed")).toBeNull();
        expect(await selectStatus(probe.sql!, run!.id)).toBe("running");
      }

      const outcome = await repo!.applyTransition(run!.id, to);
      expect(outcome, `transition ${previousStatus} -> ${to}`).not.toBeNull();
      expect(outcome!.changed).toBe(true);
      expect(outcome!.from).toBe(previousStatus);
      expect(outcome!.to).toBe(to);
      expect(outcome!.row.status).toBe(to);

      const durable = await selectRow(probe.sql!, run!.id);
      expect(durable.status).toBe(to);
      if (index > 0) {
        expect(durable.updatedAt.getTime()).toBeGreaterThan(new Date(previousUpdatedAt).getTime());
      }
      previousUpdatedAt = durable.updatedAt;
      previousStatus = to;
    }
  });

  it("enforces terminal immutability and idempotent same-state no-ops in SQL", async () => {
    const rows = await probe.sql!`select id from runs where agent_id = 'run1-int-agent' limit 1`;
    const runId = rows[0].id as string;

    expect(await repo!.applyTransition(runId, "running")).toBeNull();

    const noop = await repo!.applyTransition(runId, "completed");
    expect(noop).not.toBeNull();
    expect(noop!.changed).toBe(false);

    expect((await selectRow(probe.sql!, runId)).status).toBe("completed");
  });

  it("drives the cancel walk created -> cancelling -> cancelled via the legacy cancel port", async () => {
    const run = await repo!.createRun({
      agentId: "run1-int-agent",
      channelId: "run1-int-channel",
      runtimeType: "agentic",
    });
    createdRunIds.push(run!.id);

    const cancelled = await repo!.cancelRun(run!.id);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");

    expect(await repo!.applyTransition(cancelled!.id, "running")).toBeNull();
  });

  it("fails a starting run through the fail wrapper with an error code", async () => {
    const run = await repo!.createRun({
      agentId: "run1-int-agent",
      channelId: "run1-int-channel",
      runtimeType: "agentic",
    });
    createdRunIds.push(run!.id);

    const started = await repo!.applyTransition(run!.id, "starting");
    expect(started!.changed).toBe(true);

    const failed = await repo!.failRun(run!.id, "PROVIDER_TIMEOUT");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");

    const durable = await selectRow(probe.sql!, run!.id);
    expect(durable.status).toBe("failed");
    expect(durable.errorCode).toBe("PROVIDER_TIMEOUT");
  });
});

async function selectRow(
  sql: postgres.Sql,
  runId: string
): Promise<{ status: string; errorCode: string | null; updatedAt: Date }> {
  const rows =
    await sql`select status::text as status, error_code as "errorCode", updated_at as "updatedAt" from runs where id = ${runId}`;
  return rows[0] as { status: string; errorCode: string | null; updatedAt: Date };
}

async function selectStatus(sql: postgres.Sql, runId: string): Promise<string> {
  const rows = await sql`select status::text as status from runs where id = ${runId}`;
  return rows[0].status as string;
}
