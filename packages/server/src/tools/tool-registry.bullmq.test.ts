import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

describe("TOOL-1 · system_scheduler — bullmq path (mocked queue)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete (process.env as unknown as Record<string, string | undefined>)[k];
    for (const [k, v] of Object.entries(originalEnv)) if (v !== undefined) (process.env as unknown as Record<string, string | undefined>)[k] = v;
    vi.resetModules();
  });

  afterAll(() => {
    try { vi.doUnmock("../skills/skills-gate.js"); } catch {}
    try { vi.doUnmock("../shared/config/database.js"); } catch {}
    try { vi.doUnmock("../shared/core/sequence-number.js"); } catch {}
    try { vi.doUnmock("../shared/core/ulid.js"); } catch {}
    try { vi.doUnmock("../queue/queue-gate.js"); } catch {}
    vi.resetModules();
  });

  it("bullmq delayed job enqueues via scheduler queue and returns job id", async () => {
    process.env.QUEUE_MODE = "bullmq";
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("../skills/skills-gate.js", () => ({
      skillsGate: { getResolvedToolsForAgent: async () => ["system_scheduler", "query_database"] },
    }));
    vi.doMock("../shared/config/database.js", () => ({
      getDb: () => ({
        query: { agents: { findFirst: async () => ({ id: "agent-probe", name: "probe-agent", authorityLevel: 1, isOmniscient: true }) } },
      }),
      getSqlClient: () => ({ begin: async () => [] }),
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert: () => ({ values: async () => {} }) } as unknown),
      runWithDb: async (_db: unknown, fn: () => Promise<unknown>) => fn(),
      ensurePgVectorExtension: async () => {},
      closeDatabaseConnection: async () => {},
    }));
    vi.doMock("../shared/core/sequence-number.js", () => ({ allocateSequence: async () => 1 }));
    vi.doMock("../shared/core/ulid.js", () => ({ monotonicUlid: () => "ulid-bullmq" }));

    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const upserted: Array<{ id: string; pattern: string; name: string; data: unknown }> = [];

    vi.doMock("../queue/queue-gate.js", () => ({
      queueGate: {
        mode: () => "bullmq",
        getSchedulerQueue: () => ({
          add: async (name: string, data: unknown, opts: unknown) => {
            added.push({ name, data, opts });
            return { id: "job-123" };
          },
          upsertJobScheduler: async (id: string, pattern: { pattern: string }, opts: { name: string; data: unknown }) => {
            upserted.push({ id, pattern: pattern.pattern, name: opts.name, data: opts.data });
          },
          on: () => {},
        }),
        startSchedulerWorker: async () => ({}),
        enqueueRun: async () => null,
        scheduleMaintenance: async () => {},
        saveSchedule: async () => ({ id: "sched-mock" }),
        listActiveSchedules: async () => [],
        updateNextRun: async () => true,
        deactivateSchedule: async () => true,
        healthCheck: async () => ({ mode: "bullmq", connected: true, waiting: 0, failed: 0 }),
        drain: async () => {},
        getFailedJobs: async () => [],
      },
    }));

    const { ToolExecutor } = await import("./tool-executor.js");

    // One-shot delayed via bullmq
    const res = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      delaySeconds: 2,
      taskDescription: "bullmq-delayed-test",
      channelId: "ch-bullmq",
    });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/bullmq|Job|ID: sched-/);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe("scheduled:trigger");
    expect((added[0].data as { channelId: string }).channelId).toBe("ch-bullmq");
    expect((added[0].opts as { delay: number }).delay).toBe(2000);
    expect((added[0].opts as { jobId: string }).jobId).toMatch(/^sched-/);
  });

  it("bullmq cron repeatable uses upsertJobScheduler", async () => {
    process.env.QUEUE_MODE = "bullmq";
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("../skills/skills-gate.js", () => ({
      skillsGate: { getResolvedToolsForAgent: async () => ["system_scheduler"] },
    }));
    vi.doMock("../shared/config/database.js", () => ({
      getDb: () => ({
        query: { agents: { findFirst: async () => ({ id: "agent-probe", name: "probe-agent", authorityLevel: 1, isOmniscient: true }) } },
      }),
      getSqlClient: () => ({ begin: async () => [] }),
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert: () => ({ values: async () => {} }) } as unknown),
      runWithDb: async (_db: unknown, fn: () => Promise<unknown>) => fn(),
      ensurePgVectorExtension: async () => {},
      closeDatabaseConnection: async () => {},
    }));
    vi.doMock("../shared/core/sequence-number.js", () => ({ allocateSequence: async () => 1 }));
    vi.doMock("../shared/core/ulid.js", () => ({ monotonicUlid: () => "ulid-cron" }));

    const upserted: Array<{ id: string; pattern: string }> = [];
    vi.doMock("../queue/queue-gate.js", () => ({
      queueGate: {
        mode: () => "bullmq",
        getSchedulerQueue: () => ({
          add: async () => ({ id: "job" }),
          upsertJobScheduler: async (id: string, pat: { pattern: string }) => {
            upserted.push({ id, pattern: pat.pattern });
          },
          on: () => {},
        }),
        startSchedulerWorker: async () => ({}),
        enqueueRun: async () => null,
        scheduleMaintenance: async () => {},
        saveSchedule: async () => ({ id: "sched-mock" }),
        listActiveSchedules: async () => [],
        updateNextRun: async () => true,
        deactivateSchedule: async () => true,
        healthCheck: async () => ({ mode: "bullmq", connected: true, waiting: 0, failed: 0 }),
        drain: async () => {},
        getFailedJobs: async () => [],
      },
    }));

    const { ToolExecutor } = await import("./tool-executor.js");
    const res = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      taskDescription: "bullmq-cron",
      cron: "*/10 * * * *",
      channelId: "ch-cron",
    });
    expect(res.success).toBe(true);
    expect(upserted.length).toBe(1);
    expect(upserted[0].pattern).toBe("*/10 * * * *");
    expect(upserted[0].id).toMatch(/^sched-/);
  });

  it("deactivates the persisted row when bullmq booking fails (cron and one-shot)", async () => {
    process.env.QUEUE_MODE = "bullmq";
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("../skills/skills-gate.js", () => ({
      skillsGate: { getResolvedToolsForAgent: async () => ["system_scheduler"] },
    }));
    vi.doMock("../shared/config/database.js", () => ({
      getDb: () => ({
        query: { agents: { findFirst: async () => ({ id: "agent-probe", name: "probe-agent", authorityLevel: 1, isOmniscient: true }) } },
      }),
      getSqlClient: () => ({ begin: async () => [] }),
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert: () => ({ values: async () => {} }) } as unknown),
      runWithDb: async (_db: unknown, fn: () => Promise<unknown>) => fn(),
      ensurePgVectorExtension: async () => {},
      closeDatabaseConnection: async () => {},
    }));
    vi.doMock("../shared/core/sequence-number.js", () => ({ allocateSequence: async () => 1 }));
    vi.doMock("../shared/core/ulid.js", () => ({ monotonicUlid: () => "ulid-fail" }));

    const rows = new Map<string, { id: string; workspaceId: string; isActive: boolean }>();
    const deactivated: Array<{ id: string; workspaceId?: string | null }> = [];
    vi.doMock("../queue/queue-gate.js", () => ({
      queueGate: {
        mode: () => "bullmq",
        getSchedulerQueue: () => null,
        startSchedulerWorker: async () => ({}),
        saveSchedule: async (input: { id: string; workspaceId: string }) => {
          const row = { ...input, isActive: true };
          rows.set(input.id, row);
          return row;
        },
        listActiveSchedules: async (workspaceId?: string) =>
          [...rows.values()].filter((r) => r.isActive && (!workspaceId || r.workspaceId === workspaceId)),
        updateNextRun: async () => true,
        deactivateSchedule: async (id: string, workspaceId?: string | null) => {
          deactivated.push({ id, workspaceId });
          const row = rows.get(id);
          if (row) row.isActive = false;
          return Boolean(row);
        },
        enqueueRun: async () => null,
        scheduleMaintenance: async () => {},
        healthCheck: async () => ({ mode: "bullmq", connected: true, waiting: 0, failed: 0 }),
        drain: async () => {},
        getFailedJobs: async () => [],
      },
    }));

    const { ToolExecutor } = await import("./tool-executor.js");
    const { queueGate } = await import("../queue/queue-gate.js");

    const oneShot = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      delaySeconds: 5,
      taskDescription: "unbooked-one-shot",
      channelId: "ch-bullmq",
    });
    expect(oneShot.success).toBe(false);
    expect(oneShot.error).toMatch(/Scheduler queue unavailable/);
    expect(await queueGate.listActiveSchedules("default")).toHaveLength(0);

    const cron = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      taskDescription: "unbooked-cron",
      cron: "*/5 * * * *",
      channelId: "ch-bullmq",
    });
    expect(cron.success).toBe(false);
    expect(await queueGate.listActiveSchedules("default")).toHaveLength(0);
    expect(deactivated).toHaveLength(2);
  });
});
