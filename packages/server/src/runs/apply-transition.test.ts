import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

// Scripted DB: every select/update pops the next entry, so a lost
// `WHERE status = from` race can be simulated deterministically.
const script = vi.hoisted(() => {
  const state = {
    reads: [] as Row[][],
    writes: [] as Row[][],
    selectCalls: 0,
    updateCalls: 0,
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
  };
  return state;
});

vi.mock("../shared/config/database.js", () => ({ getDb: () => script.db }));

import { applyTransition } from "./runs-repository.js";

function reset(reads: Row[][], writes: Row[][]) {
  script.reads = [...reads.map((r) => [...r])];
  script.writes = [...writes.map((w) => [...w])];
  script.selectCalls = 0;
  script.updateCalls = 0;
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
});
