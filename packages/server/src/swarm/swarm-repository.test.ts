import { describe, it, expect, beforeEach } from "vitest";
import {
  createSwarmTasks,
  updateSwarmTaskStatus,
  listSwarmTasksByRun,
  getSwarmTaskById,
  deleteSwarmTasksByRun,
  resetSwarmForTests,
} from "./swarm-repository.js";

const task = (id: string) => ({ id, dependsOn: [], assigneeTemplate: "agent-1" });

describe("swarm repository run isolation (CRITICAL-1)", () => {
  beforeEach(() => {
    resetSwarmForTests();
  });

  it("two runs can hold task-1 simultaneously without cross-talk", async () => {
    await createSwarmTasks("run-aaa", [task("task-1")]);
    await createSwarmTasks("run-bbb", [task("task-1")]);

    await updateSwarmTaskStatus("run-aaa", "task-1", "running");
    await updateSwarmTaskStatus("run-aaa", "task-1", "completed", "output-A");

    const rowA = await getSwarmTaskById("run-aaa", "task-1");
    const rowB = await getSwarmTaskById("run-bbb", "task-1");
    expect(rowA?.status).toBe("completed");
    expect(rowA?.outputRef).toBe("output-A");
    // Same bare id in the other run must be untouched — namespacing is internal.
    expect(rowB?.status).toBe("pending");
    expect(rowB?.outputRef ?? null).toBeNull();

    // Consumers see bare ids scoped by runId, never the internal composite.
    expect(rowA?.id).toBe("task-1");
    expect(rowA?.runId).toBe("run-aaa");
    expect(rowB?.runId).toBe("run-bbb");

    const listA = await listSwarmTasksByRun("run-aaa");
    const listB = await listSwarmTasksByRun("run-bbb");
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0].status).toBe("completed");
    expect(listB[0].status).toBe("pending");
  });

  it("deleteByRun removes only that run's rows", async () => {
    await createSwarmTasks("run-aaa", [task("task-1")]);
    await createSwarmTasks("run-bbb", [task("task-1")]);

    await deleteSwarmTasksByRun("run-aaa");

    expect(await listSwarmTasksByRun("run-aaa")).toHaveLength(0);
    expect(await listSwarmTasksByRun("run-bbb")).toHaveLength(1);
    expect(await getSwarmTaskById("run-bbb", "task-1")).not.toBeNull();
  });

  it("rejects invalid status transitions so a stale write cannot rewind a terminal row", async () => {
    await createSwarmTasks("run-aaa", [task("task-1")]);
    await updateSwarmTaskStatus("run-aaa", "task-1", "running");
    await updateSwarmTaskStatus("run-aaa", "task-1", "completed", "done");

    // completed → running is not an allowed transition; row must stay completed.
    await updateSwarmTaskStatus("run-aaa", "task-1", "running");
    const row = await getSwarmTaskById("run-aaa", "task-1");
    expect(row?.status).toBe("completed");
  });

  it("caps the in-memory index at 500 rows, evicting the oldest everywhere", async () => {
    const tasks = Array.from({ length: 501 }, (_, i) => task(`t${i}`));
    await createSwarmTasks("run-cap", tasks);
    expect(await getSwarmTaskById("run-cap", "t0")).toBeNull();
    expect(await getSwarmTaskById("run-cap", "t500")).not.toBeNull();
    expect((await listSwarmTasksByRun("run-cap")).length).toBe(500);
  });
});
