import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCompensation, deleteCompensation } = vi.hoisted(() => ({
  getCompensation: vi.fn(),
  deleteCompensation: vi.fn(),
}));

vi.mock("./runs-repository.js", () => ({
  getRunById: vi.fn(),
  applyTransition: vi.fn(),
  getCompensation,
  deleteCompensation,
  listCompensations: vi.fn(),
}));

import { undoCompensation } from "./runs-service.js";

function rowWith(inverseOp: unknown) {
  return { id: "comp-1", runId: "run-1", seq: 1, inverseOp };
}

describe("undoCompensation refusal paths", () => {
  beforeEach(() => {
    getCompensation.mockReset();
    deleteCompensation.mockReset();
  });

  it("returns not found without touching the journal", async () => {
    getCompensation.mockResolvedValue(null);
    const res = await undoCompensation("run-1", "comp-1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
    expect(deleteCompensation).not.toHaveBeenCalled();
  });

  it("refuses a store-time-truncated restore and keeps the row", async () => {
    getCompensation.mockResolvedValue(
      rowWith({ op: "restore", path: "/a.ts", priorHash: "deadbeef", priorContentRef: "x".repeat(20000), truncated: true })
    );
    const res = await undoCompensation("run-1", "comp-1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/truncated/);
    expect(deleteCompensation).not.toHaveBeenCalled();
  });

  it("refuses an unknown inverse op and keeps the row", async () => {
    getCompensation.mockResolvedValue(rowWith({ op: "patch", path: "/a.ts" }));
    const res = await undoCompensation("run-1", "comp-1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown/);
    expect(deleteCompensation).not.toHaveBeenCalled();
  });

  it("refuses a restore whose stored content no longer matches priorHash", async () => {
    getCompensation.mockResolvedValue(
      rowWith({ op: "restore", path: "/a.ts", priorHash: "0".repeat(64), priorContentRef: "corrupted" })
    );
    const res = await undoCompensation("run-1", "comp-1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hash mismatch/);
    expect(deleteCompensation).not.toHaveBeenCalled();
  });
});
