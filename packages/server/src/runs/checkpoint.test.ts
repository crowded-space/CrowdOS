import { describe, it, expect } from "vitest";
import { buildCompensationInverse } from "./runs-repository.js";
import { canTransition } from "./run-state-machine.js";

describe("RES-1 checkpoint & compensation unit", () => {
  it("orphan transitions exist for RES-1", () => {
    expect(canTransition("running", "orphaned")).toBe(true);
    expect(canTransition("starting", "orphaned")).toBe(true);
    expect(canTransition("completing", "orphaned")).toBe(true);
    expect(canTransition("waiting_for_tool", "orphaned")).toBe(true);
    expect(canTransition("orphaned", "resumable")).toBe(true);
    expect(canTransition("resumable", "queued")).toBe(true);
  });

  it("buildCompensationInverse for created file => delete", () => {
    const op = buildCompensationInverse({ existed: false, priorContent: null, path: "/src/new.ts" });
    expect(op).toEqual({ op: "delete", path: "/src/new.ts" });
  });

  it("buildCompensationInverse for modified file => restore with hash", () => {
    const prior = "hello world content";
    const op = buildCompensationInverse({ existed: true, priorContent: prior, path: "/src/a.ts" });
    expect(op.op).toBe("restore");
    expect(op.path).toBe("/src/a.ts");
    expect(op.priorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(op.priorContentRef).toBe(prior);
  });

  it("buildCompensationInverse truncates large prior content to 20k", () => {
    const big = "x".repeat(25000);
    const op = buildCompensationInverse({ existed: true, priorContent: big, path: "/src/big.ts" });
    expect(op.op).toBe("restore");
    expect(op.priorContentRef!.length).toBe(20000);
  });

  it("resume dedupe skips completed ids (AgenticRuntime logic)", async () => {
    const completed = new Set(["call-1", "call-2"]);
    const executableCalls = [
      { id: "call-1", name: "write_file", input: {} },
      { id: "call-2", name: "delete_file", input: {} },
      { id: "call-3", name: "read_file", input: {} },
      { id: "call-4", name: "write_file", input: {} },
    ];
    const toExecute: number[] = [];
    const skipped: Set<number> = new Set();
    for (let idx = 0; idx < executableCalls.length; idx++) {
      const cid = executableCalls[idx].id;
      if (cid && completed.has(cid)) skipped.add(idx);
      else toExecute.push(idx);
    }
    expect([...skipped]).toEqual([0, 1]);
    expect(toExecute).toEqual([2, 3]);
    expect(executableCalls.filter((_, i) => !skipped.has(i)).map(c => c.id)).toEqual(["call-3", "call-4"]);
  });

  it("checkpoint merge dedupes completedCallIds", () => {
    const existing = { watermarkSeq: 5, completedCallIds: ["a", "b"], updatedAt: new Date().toISOString() };
    const patch = { completedCallIds: ["b", "c"], watermarkSeq: 10 };
    const mergedIds = [...existing.completedCallIds];
    for (const id of patch.completedCallIds) if (!mergedIds.includes(id)) mergedIds.push(id);
    expect(mergedIds).toEqual(["a", "b", "c"]);
    expect(patch.watermarkSeq).toBe(10);
  });
});
