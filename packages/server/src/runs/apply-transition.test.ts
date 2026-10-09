import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

// Scripted DB: every select/update pops the next entry, so a lost
// `WHERE status = from` race can be simulated deterministically.
const script = vi.hoisted(() => {
  const state = {
    reads: [] as Row[][],
    writes: [] as Row[][],
    selectCalls: 0,
    updateCalls: 0,
    insertError: false,
    insertCalls: 0,
    db: null as unknown,
  };
  state.db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.selectCalls++;
            return state.reads.shift() ?? [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            state.updateCalls++;
            return state.writes.shift() ?? [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (_values: Row) => {
        if (state.insertError) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        state.insertCalls++;
        return { returning: async () => [{ id: "comp-1" }] };
      },
    }),
  };
  return state;
});

vi.mock("../shared/config/database.js", () => ({ getDb: () => script.db }));

import { applyTransition, addCompensation } from "./runs-repository.js";

function reset(reads: Row[][], writes: Row[][]) {
  script.reads = [...reads.map((r) => [...r])];
  script.writes = [...writes.map((w) => [...w])];
  script.selectCalls = 0;
  script.updateCalls = 0;
  script.insertError = false;
  script.insertCalls = 0;
}

describe("applyTransition CAS retry", () => {
  it("retries once when the WHERE race loses and returns the real outcome", async () => {
    reset(
      [
        [{ id: "r1", status: "running" }],
        [{ id: "r1", status: "waiting_for_tool" }],
      ],
      [[], [{ id: "r1", status: "completing" }]]
    );
    const result = await applyTransition("r1", "completing");
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.from).toBe("waiting_for_tool");
    expect(result!.row.status).toBe("completing");
    expect(script.selectCalls).toBe(2);
    expect(script.updateCalls).toBe(2);
  });

  it("returns null when the race is lost twice", async () => {
    reset(
      [
        [{ id: "r1", status: "running" }],
        [{ id: "r1", status: "running" }],
      ],
      [[], []]
    );
    expect(await applyTransition("r1", "completing")).toBeNull();
    expect(script.updateCalls).toBe(2);
  });

  it("returns null without writing on an illegal transition", async () => {
    reset([[{ id: "r1", status: "completed" }]], []);
    expect(await applyTransition("r1", "running")).toBeNull();
    expect(script.updateCalls).toBe(0);
  });

  it("returns changed=false with the fresh row on same-state no-op", async () => {
    reset([[{ id: "r1", status: "running" }]], []);
    const result = await applyTransition("r1", "running");
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(false);
    expect(result!.row.status).toBe("running");
    expect(script.updateCalls).toBe(0);
  });

  // RUN-001: errorCode is sticky. A reason-only hop must not erase the
  // stored failure code; explicit null clears it.
  it("preserves a stored errorCode on hops that do not set one (RUN-001)", async () => {
    reset(
      [[{ id: "r1", status: "running", errorCode: "E_BOOT" }]],
      [[{ id: "r1", status: "waiting_for_tool", errorCode: "E_BOOT" }]]
    );
    const result = await applyTransition("r1", "waiting_for_tool", { reason: "tool call" });
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.row.errorCode).toBe("E_BOOT");
  });

  it("clears errorCode only on explicit null (RUN-001)", async () => {
    reset(
      [[{ id: "r1", status: "running", errorCode: "E_BOOT" }]],
      [[{ id: "r1", status: "failed", errorCode: null }]]
    );
    const result = await applyTransition("r1", "failed", { errorCode: null });
    expect(result).not.toBeNull();
    expect(result!.row.errorCode).toBeNull();
  });

  // RUN-003: journal BEFORE mutate. Both coding-runtime handlers must call
  // runsGate.addCompensation before fs.writeFile so a crash between the two
  // leaves a journal row (undo possible), never an un-undoable file change.
  it("coding-runtime journals compensation before fs.writeFile in both handlers (RUN-003)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../runtime/runtimes/coding-runtime.ts", import.meta.url)),
      "utf8"
    );
    for (const [journal, write] of [
      ["toolName: 'write_file'", "await fs.writeFile(resolved, content, 'utf8')"],
      ["toolName: 'edit_file'", "await fs.writeFile(resolved, finalContent, 'utf8')"],
    ]) {
      const journalIdx = src.indexOf(`addCompensation(packet.runId as string, { ${journal}`);
      const writeIdx = src.indexOf(write);
      expect(journalIdx).toBeGreaterThan(-1);
      expect(writeIdx).toBeGreaterThan(-1);
      expect(journalIdx).toBeLessThan(writeIdx);
    }
    // The old ordering (write, then bare-catch journal) is gone: no bare
    // swallow may remain on the journal path.
    expect(src).not.toMatch(/await fs\.writeFile[\s\S]{0,400}runsGate\.addCompensation/);
  });

  // RUN-004: a failed journal insert is observable. addCompensation must emit
  // the structured warn line (stage runs.compensation_journal_failed) so
  // operators can alert on silent loss of undo capability.
  it("addCompensation failure emits a structured warn and returns null (RUN-004)", async () => {
    reset([], []);
    script.insertError = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const row = await addCompensation("r1", {
        toolName: "write_file",
        targetPath: "a.txt",
        inverseOp: { op: "delete", path: "a.txt" },
      });
      expect(row).toBeNull();
      const structured = warn.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("runs.compensation_journal_failed"));
      expect(structured).toBeDefined();
      expect(structured).toContain("\"level\":\"warn\"");
      expect(structured).toContain("a.txt");
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// RUN-006 / RUN-026 regression (fix-runs-micro-006-026). Both fixes live in
// Runtime/Routes files; asserted from the runs suite so `npx vitest run
// src/runs` guards them.
// ---------------------------------------------------------------------------

const resumeScript = vi.hoisted(() => ({
  mode: "bullmq" as "bullmq" | "inline",
  enqueue: vi.fn(),
  resumeRun: vi.fn(),
  getById: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("./runs-gate.js", () => ({
  runsGate: {
    resumeRun: resumeScript.resumeRun,
    getById: resumeScript.getById,
    transition: resumeScript.transition,
  },
}));

vi.mock("../queue/queue-gate.js", () => ({
  queueGate: {
    mode: () => resumeScript.mode,
    enqueueRun: resumeScript.enqueue,
  },
}));

// The refusal path never reaches the assembler or a runtime, and the close
// walk goes through stateGate — stub all three seams so the executor import
// stays on the mocked gate + pure interpreter/router.
vi.mock("../state/state-gate.js", () => ({
  stateGate: { applyRunTransition: resumeScript.transition },
}));

vi.mock("../runtime/kernel/context-assembler.js", () => ({
  ContextAssembler: class {
    async assemble(): Promise<never> {
      throw new Error("assemble not expected in refusal test");
    }
  },
}));

vi.mock("../runtime/runtimes/conversational-runtime.js", () => ({ ConversationalRuntime: class {} }));
vi.mock("../runtime/runtimes/agentic-runtime.js", () => ({ AgenticRuntime: class {} }));
vi.mock("../runtime/runtimes/swarm-runtime.js", () => ({ SwarmRuntime: class {} }));
vi.mock("../runtime/runtimes/coding-runtime.js", () => ({ CodingRuntime: class {} }));
vi.mock("../runtime/runtimes/research-runtime.js", () => ({ ResearchRuntime: class {} }));

describe("RUN-006 resume delivery honesty", () => {
  it("route reports delivery:failed when enqueue throws (200 kept) and the socket ack carries delivery", async () => {
    const Fastify = (await import("fastify")).default;
    const { runsRoutes } = await import("../routes/runs.js");
    const app = Fastify();
    await app.register(runsRoutes);
    await app.ready();

    resumeScript.mode = "bullmq";
    resumeScript.resumeRun.mockResolvedValue({
      run: { id: "run-006", agentId: "ag-1", channelId: "ch-1", workspaceId: null, status: "queued" },
      checkpoint: null,
    });

    resumeScript.enqueue.mockRejectedValueOnce(new Error("redis down"));
    const failed = await app.inject({ method: "POST", url: "/api/runs/run-006/resume" });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ delivery: "failed" });
    expect(failed.json().deliveryDetail).toContain("redis down");

    resumeScript.enqueue.mockResolvedValueOnce(undefined);
    const ok = await app.inject({ method: "POST", url: "/api/runs/run-006/resume" });
    expect(ok.json()).toMatchObject({ delivery: "queued" });

    await app.close();

    // Socket leg: the run:resume:ok ack must carry the delivery flag too.
    const socketSrc = readFileSync(
      fileURLToPath(new URL("../shared/sockets/register-socket-server.ts", import.meta.url)),
      "utf8"
    );
    expect(socketSrc).toContain("delivery, ...(deliveryDetail ? { deliveryDetail } : {})");
    expect(socketSrc).toContain('status: run.status, delivery: "failed", deliveryDetail:');
  });
});

describe("RUN-026 executor stale-state refusal", () => {
  it("refuses a fetched row in a non-executable status without resume context", async () => {
    const { RuntimeExecutor } = await import("../runtime/runtime-executor.js");
    const exec = new RuntimeExecutor();

    for (const status of ["resumable", "failed"] as const) {
      const row = { id: `run-026-${status}`, status, agentId: "ag-1", channelId: "ch-1", workspaceId: "ws-1" };
      resumeScript.getById.mockResolvedValueOnce(row);
      resumeScript.transition.mockResolvedValueOnce({ row, from: status, to: "failed", changed: false, reason: null });

      const result = await exec.execute({
        agent: { id: "ag-1", name: "Tester", authorityLevel: 3 } as unknown as never,
        channelId: "ch-1",
        workspaceId: "ws-1",
        userInput: "hello",
        broker: {} as unknown as never,
        runId: row.id,
      });

      expect(result.status).toBe("failed");
      expect(result.finalResponse).toContain("refusing to execute with stale state");
      expect(result.runtimeEvents).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// RUN-030 / RUN-031 regression (fix-runs-micro-030-031). The fix is the queue
// worker's job/run correlation guard; asserted from the runs suite so
// `npx vitest run src/runs` guards it.
// ---------------------------------------------------------------------------

const workerGuardScript = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ status: "completed" })),
  getSharedBroker: vi.fn(),
}));

vi.mock("../runtime/runtime-gate.js", () => ({
  runtimeGate: { execute: workerGuardScript.execute },
}));

vi.mock("../agents/agent-gate.js", () => ({
  agentGate: { getById: vi.fn(), list: vi.fn(async () => []) },
}));

vi.mock("../event-broker/event-broker-gate.js", () => ({
  getSharedBroker: workerGuardScript.getSharedBroker,
}));

function makeGuardJob(data: Record<string, unknown>) {
  return {
    data,
    attemptsMade: 0,
    updateProgress: vi.fn(async () => ({})),
    extendLock: vi.fn(async () => {}),
  };
}

describe("RUN-030/031 worker job-run correlation guard", () => {
  it("refuses the stale backlog job of a swept/resumed run (RUN-030)", async () => {
    const { processRunJob } = await import("../queue/run-worker.js");
    workerGuardScript.getSharedBroker.mockReturnValue({ onAny: () => "hb-1", off: () => {} });
    // The >10min backlog job (no resumeContext, attemptsMade 0) fires late:
    // - pre-resume the sweep already reaped the row to resumable (refused as
    //   stale), and
    // - post-resume the row is queued — resume-exclusive, so the old job must
    //   refuse or it duplicates the resume execution.
    for (const [status, reason] of [
      ["resumable", "stale_run_status"],
      ["queued", "resume_exclusive_status"],
    ] as const) {
      resumeScript.getById.mockResolvedValueOnce({ id: "run-030", status, parentRunId: null });
      const result = await processRunJob(
        makeGuardJob({ channelId: "ch-1", agentId: "ag-1", messageId: "msg-1", userInput: "hi", runId: "run-030" }) as any,
      );
      expect(result).toMatchObject({ skipped: true, reason, runId: "run-030" });
    }
    expect(workerGuardScript.execute).not.toHaveBeenCalled();
  });

  it("refuses a research child-trace job before executing it (RUN-031)", async () => {
    const { processRunJob } = await import("../queue/run-worker.js");
    workerGuardScript.getSharedBroker.mockReturnValue({ onAny: () => "hb-1", off: () => {} });
    // research-runtime enqueues child rows (runId=childId, no resumeContext)
    // as audit traces while the parent executes the search inline; the worker
    // must refuse the parentRunId row, never adopt it for a second execution.
    resumeScript.getById.mockResolvedValueOnce({ id: "child-1", status: "running", parentRunId: "parent-1" });
    const result = await processRunJob(
      makeGuardJob({ channelId: "ch-1", agentId: "ag-1", messageId: "res-sub-0-1", userInput: "subQ", runId: "child-1" }) as any,
    );
    expect(result).toMatchObject({ skipped: true, reason: "child_trace_row", runId: "child-1" });
    expect(workerGuardScript.execute).not.toHaveBeenCalled();
  });
});
