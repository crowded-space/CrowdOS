import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import {
  localDeleteRuntimeOverride,
  localListRuntimeOverrides,
  localSweepExpiredRuntimeOverrides,
  localUpsertRuntimeOverride,
} from "./agent-runtime-override-local-store.js";

// File tier for runtime overrides: the local mirror of the PG
// `runtime_overrides` table (same row shape, same id/priority semantics).

let dir: string;

const WS = "ws-overrides";
const OTHER_WS = "ws-overrides-other";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-runtime-overrides-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    targetAgentId: "agent-1",
    overrideType: "runtime_patch" as const,
    instructionPatch: { append: ["PATCHED"] },
    createdBy: "studio",
    ...overrides,
  };
}

function storeFile(workspaceId: string): string {
  return join(dir, workspaceId, "vfs", ".crowdos", "runtime-overrides.json");
}

describe("runtime override local store", () => {
  it("round-trips a write, a read and a delete", async () => {
    const written = await localUpsertRuntimeOverride(row(), WS);

    const listed = await localListRuntimeOverrides("agent-1", WS);
    expect(listed).toEqual([written]);

    expect(await localDeleteRuntimeOverride("agent-1", written.id, WS)).toBe(true);
    expect(await localListRuntimeOverrides("agent-1", WS)).toEqual([]);
    // A second delete finds nothing — the row is gone, not just hidden.
    expect(await localDeleteRuntimeOverride("agent-1", written.id, WS)).toBe(false);
  });

  it("writes the canon per-workspace file with the PG row shape", async () => {
    const written = await localUpsertRuntimeOverride(row(), WS);

    const path = storeFile(WS);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toEqual([
      {
        id: written.id,
        targetAgentId: "agent-1",
        overrideType: "runtime_patch",
        instructionPatch: { append: ["PATCHED"] },
        permissionPatch: null,
        createdBy: "studio",
        expiresAt: null,
        createdAt: written.createdAt,
      },
    ]);
    // Another workspace keeps its own file — no cross-workspace bleed.
    expect(existsSync(storeFile(OTHER_WS))).toBe(false);
  });

  it("lists the agent's rows in id order (the patch order the semantics rely on)", async () => {
    const first = await localUpsertRuntimeOverride(row(), WS);
    const second = await localUpsertRuntimeOverride(
      row({ instructionPatch: { append: ["SECOND"] } }),
      WS,
    );

    const listed = await localListRuntimeOverrides("agent-1", WS);
    expect(listed.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it("hides expired rows from the list and sweeps them from disk", async () => {
    const live = await localUpsertRuntimeOverride(row(), WS);
    const expired = await localUpsertRuntimeOverride(
      row({ id: "rov-expired", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
      WS,
    );

    expect(await localListRuntimeOverrides("agent-1", WS)).toEqual([live]);

    expect(await localSweepExpiredRuntimeOverrides("agent-1", WS)).toBe(1);
    expect(await localListRuntimeOverrides("agent-1", WS)).toEqual([live]);
    const raw = JSON.parse(readFileSync(storeFile(WS), "utf8"));
    expect(raw.map((r: { id: string }) => r.id)).toEqual([live.id]);
    expect(raw.some((r: { id: string }) => r.id === expired.id)).toBe(false);
  });

  it("keeps an expired row that belongs to another agent out of the sweep", async () => {
    const otherAgent = await localUpsertRuntimeOverride(
      row({ targetAgentId: "agent-2", id: "rov-other", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
      WS,
    );

    expect(await localSweepExpiredRuntimeOverrides("agent-1", WS)).toBe(0);
    expect(await localListRuntimeOverrides("agent-2", WS)).toEqual([]);
    const raw = JSON.parse(readFileSync(storeFile(WS), "utf8"));
    expect(raw.map((r: { id: string }) => r.id)).toEqual([otherAgent.id]);
  });

  it("scopes rows per agent and per workspace", async () => {
    await localUpsertRuntimeOverride(row({ id: "rov-a" }), WS);
    await localUpsertRuntimeOverride(row({ id: "rov-b", targetAgentId: "agent-2" }), WS);
    await localUpsertRuntimeOverride(row({ id: "rov-c" }), OTHER_WS);

    expect((await localListRuntimeOverrides("agent-1", WS)).map((r) => r.id)).toEqual(["rov-a"]);
    expect((await localListRuntimeOverrides("agent-2", WS)).map((r) => r.id)).toEqual(["rov-b"]);
    expect((await localListRuntimeOverrides("agent-1", OTHER_WS)).map((r) => r.id)).toEqual(["rov-c"]);
  });

  it("replaces a row in place when the same id is written again", async () => {
    const written = await localUpsertRuntimeOverride(row({ id: "rov-fixed" }), WS);
    await localUpsertRuntimeOverride(
      row({ id: "rov-fixed", instructionPatch: { append: ["REPLACED"] } }),
      WS,
    );

    const listed = await localListRuntimeOverrides("agent-1", WS);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(written.id);
    expect(listed[0].instructionPatch).toEqual({ append: ["REPLACED"] });
  });
});
