import { describe, it, expect } from "vitest";
import { buildCompensationInverse } from "./runs-repository.js";
import { canTransition } from "./run-state-machine.js";

describe("RES-1 checkpoint & compensation unit", () => {
  it("orphan transitions exist for RES-1", () => {
    expect(canTransition("created", "orphaned")).toBe(true);
    expect(canTransition("queued", "orphaned")).toBe(true);
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

  it("buildCompensationInverse truncates large prior content to 20k and flags it", () => {
    const big = "x".repeat(25000);
    const op = buildCompensationInverse({ existed: true, priorContent: big, path: "/src/big.ts" });
    expect(op.op).toBe("restore");
    expect(op.priorContentRef!.length).toBe(20000);
    expect((op as { truncated?: boolean }).truncated).toBe(true);
  });
});
