import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { channelGate } from "./channel-gate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-channel-ws-read-"));
  setLocalStoreDirForTests(dir);
  return () => { setLocalStoreDirForTests(null); rmSync(dir, { recursive: true, force: true }); };
});

describe("channels scoped reads resolve the workspace tier first", () => {
  it("asks the tenant database before the global pool and stays scoped on a miss", async () => {
    const ws = "ws-scoped-read";
    const cat: any = await channelGate.createCategory({ name: "General", workspaceId: ws, createdBy: "t" });
    expect(await channelGate.categoryExists(cat.id, undefined, ws)).toBe(true);

    const database = await import("../shared/config/database.js");
    const tenantDb = {
      query: { categories: { findFirst: async () => null } },
    };
    const forWorkspace = vi.spyOn(database, "dbForWorkspace").mockResolvedValue(tenantDb as any);
    const globalDb = vi.spyOn(database, "getDb").mockImplementation(() => {
      throw new Error("global pool must not answer a workspace-scoped read");
    });
    try {
      expect(await channelGate.categoryExists(cat.id, undefined, ws)).toBe(true);
      expect(await channelGate.categoryExists("missing-" + Date.now(), undefined, ws)).toBe(false);
      expect(forWorkspace).toHaveBeenCalledWith(ws);
    } finally {
      forWorkspace.mockRestore();
      globalDb.mockRestore();
    }
  });
});
