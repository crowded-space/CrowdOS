// THR-016 + THR-025 regression pins.
//
// THR-016 (ownership / split write): thread_sequences has ONE owner, Threads.
// The allocator lives in thread-sequence-allocator.ts and is exposed only as
// threadGate.allocateSequence; the old shared helper is deleted, and the
// Messages append path calls the gate. The ownership test asserts both the
// file layout and that nothing outside the Threads domain names the table.
//
// THR-025 (tenancy / implicit context): every thread port takes an explicit
// threadCallContext. A non-HTTP caller that passes its workspaceId resolves
// that workspace record DB (dbForWorkspace) and fails closed when it cannot —
// it can never silently read/write the global/default pool.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

import * as databaseModule from "../shared/config/database.js";
import { threadGate } from "./thread-gate.js";

const SRC = fileURLToPath(new URL("..", import.meta.url)); // packages/server/src

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function rel(p: string): string {
  return p.slice(SRC.length).replace(/^[\\/]/, "").split(sep).join("/");
}

describe("THR-016 thread_sequences single-owner (Threads)", () => {
  it("no shared allocator remains and only Threads names the table", () => {
    expect(existsSync(join(SRC, "shared", "core", "thread-sequence.ts"))).toBe(false);
    expect(existsSync(join(SRC, "threads", "thread-sequence-allocator.ts"))).toBe(true);

    const files = walkTs(SRC);
    const importers = files.filter((f) => readFileSync(f, "utf8").includes("thread-sequence-allocator.js")).map(rel);
    // Exactly one importer outside the allocator itself: the Threads gate.
    expect(importers).toEqual(["threads/thread-gate.ts"]);

    const tableNamers = files.filter((f) => readFileSync(f, "utf8").includes("threadSequences")).map(rel).sort();
    expect(tableNamers).toEqual([
      "db/schema.ts",
      "threads/thread-sequence-allocator.ts",
      "threads/thread-service.ts",
    ]);

    // Gate-to-gate: the Messages append path calls the Threads gate port.
    const messageService = readFileSync(join(SRC, "messages", "message-service.ts"), "utf8");
    expect(messageService).toContain("threadGate.allocateSequence(input.threadId, 1, tx)");
    expect(messageService).not.toContain("thread-sequence");
  });

  it("gate allocator contract: tx-bound reservation, self-heal, batch start value", async () => {
    // Handcrafted tx client: proves the allocator runs entirely on the passed
    // transaction (no ambient getDb) and self-heals a missing counter row.
    const state = { lastSeq: null as number | null, healed: false };
    const tx: any = {
      query: {
        threadSequences: {
          findFirst: async () => (state.lastSeq === null ? null : { threadId: "thr_t", lastSeq: state.lastSeq }),
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ max: 5 }] }) }),
      insert: () => ({
        values: (v: any) => {
          const exec = async () => {
            state.lastSeq = (state.lastSeq ?? 0) + Number(v.lastSeq ?? 0);
            if (Number(v.lastSeq ?? 0) === 5) state.healed = true; // bootstrap seed
            return { lastSeq: state.lastSeq };
          };
          return {
            onConflictDoNothing: async () => { await exec(); },
            onConflictDoUpdate: () => ({ returning: async () => [await exec()] }),
          };
        },
      }),
    };

    // First reservation self-heals from MAX(messages.sequence_number) = 5.
    expect(await threadGate.allocateSequence("thr_t", 1, tx)).toBe(6);
    expect(state.healed).toBe(true);
    // Steady state increments atomically; batch returns the START value.
    expect(await threadGate.allocateSequence("thr_t", 1, tx)).toBe(7);
    expect(await threadGate.allocateSequence("thr_t", 3, tx)).toBe(8);
    expect(state.lastSeq).toBe(10);
  });
});

describe("THR-025 explicit workspace context (non-HTTP callers)", () => {
  const socketTestDb = (databaseModule as any).__socketTestDb as {
    store: { channels: Record<string, unknown>[] };
    reset(): void;
    setWorkspaceDbResolver(fn: ((workspaceId: string) => Promise<unknown> | unknown) | null): void;
  };

  beforeEach(() => {
    socketTestDb.reset();
    socketTestDb.store.channels.push({ id: "shared-ch", workspaceId: "ws-a" });
  });

  it("routes each call to the caller workspace handle and never the global pool", async () => {
    const hA: any = await (databaseModule as any).dbForWorkspace("ws-a");
    const hB: any = await (databaseModule as any).dbForWorkspace("ws-b");
    expect(hA.__workspaceMarker).toBe("ws-a");
    expect(hB.__workspaceMarker).toBe("ws-b");

    const requested: string[] = [];
    socketTestDb.setWorkspaceDbResolver((ws) => {
      requested.push(ws);
      return ws === "ws-a" ? hA : hB;
    });

    const created: any = await threadGate.create(
      { channelId: "shared-ch", createdBy: "worker" },
      { workspaceId: "ws-a" },
    );
    expect(created.thread?.channelId).toBe("shared-ch");

    // Same channel id shape in a second workspace: the list resolves the
    // second workspace handle explicitly — two handles, two tenants, no
    // ambient fallback (requested records every resolution).
    await threadGate.list("shared-ch", { includeArchived: true }, { workspaceId: "ws-b" });
    await threadGate.get("thr_missing", { workspaceId: "ws-a" });
    expect(requested).toEqual(["ws-a", "ws-b", "ws-a"]);

    // Explicit db pin wins too (tests/seeds/replay callers).
    const before = requested.length;
    await threadGate.list("shared-ch", undefined, { db: hA });
    expect(requested.length).toBe(before);

    // No context: the ambient handle (request ALS / global pool) still serves
    // HTTP-style callers unchanged.
    socketTestDb.setWorkspaceDbResolver(null);
    await expect(threadGate.list("shared-ch")).resolves.toEqual([]);
  });

  it("fails closed for a workspace with no record DB instead of using the default", async () => {
    socketTestDb.setWorkspaceDbResolver(() => {
      throw Object.assign(new Error("NO_DATABASE: workspace ws-local-only is local-only"), { code: "NO_DATABASE" });
    });
    await expect(threadGate.list("shared-ch", undefined, { workspaceId: "ws-local-only" })).rejects.toMatchObject({
      code: "NO_DATABASE",
    });
    await expect(threadGate.archiveExpired({ workspaceId: "ws-local-only" })).rejects.toMatchObject({
      code: "NO_DATABASE",
    });
  });
});
