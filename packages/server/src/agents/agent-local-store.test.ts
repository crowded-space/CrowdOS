import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import {
  localGetAgent,
  localListAgents,
  localUpsertAgent,
} from "./agent-local-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-agents-local-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-a",
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
    ...overrides,
  };
}

describe("agent local store — full-field persistence (C3)", () => {
  it("persists every agent field on create and reads them back identically", async () => {
    const created = await localUpsertAgent(
      baseInput({
        species: "Raven",
        avatar: "🐦",
        l3Subtype: undefined,
        modelModuleId: "mod-model-1",
        instructionModuleId: "instr-1",
        toolkitModuleId: "tool-1",
        constraintsModuleId: "cons-1",
        capabilitiesModuleId: "cap-1",
        memorySharingPolicy: "vertical",
        isOmniscient: true,
        fallbackAgentId: "agent-fallback",
        categoryPermissions: ["ops"],
        permissions: { spawnAgents: true, patchRuntime: false, accessAllChannels: true },
        status: "idle",
        isTemplate: false,
      }),
    );

    const read = await localGetAgent(created.id, "ws-a");
    expect(read).not.toBeNull();
    expect(read.species).toBe("Raven");
    expect(read.avatar).toBe("🐦");
    expect(read.modelModuleId).toBe("mod-model-1");
    expect(read.instructionModuleId).toBe("instr-1");
    expect(read.toolkitModuleId).toBe("tool-1");
    expect(read.constraintsModuleId).toBe("cons-1");
    expect(read.capabilitiesModuleId).toBe("cap-1");
    expect(read.memorySharingPolicy).toBe("vertical");
    expect(read.isOmniscient).toBe(true);
    expect(read.fallbackAgentId).toBe("agent-fallback");
    expect(read.categoryPermissions).toEqual(["ops"]);
    expect(read.permissions).toEqual({ spawnAgents: true, patchRuntime: false, accessAllChannels: true });
  });

  it("merge-updates: omitted fields keep their stored values", async () => {
    const created = await localUpsertAgent(
      baseInput({
        species: "Crow",
        toolkitModuleId: "tool-keep",
        isOmniscient: true,
        permissions: { spawnAgents: true, patchRuntime: true, accessAllChannels: true },
      }),
    );

    await localUpsertAgent({
      id: created.id,
      workspaceId: "ws-a",
      name: "scout-renamed",
      title: "Scout Renamed",
      authorityLevel: 2,
      status: "idle",
    });

    const read = await localGetAgent(created.id, "ws-a");
    expect(read.name).toBe("scout-renamed");
    expect(read.title).toBe("Scout Renamed");
    expect(read.authorityLevel).toBe(2);
    // Unspecified fields survive the update.
    expect(read.species).toBe("Crow");
    expect(read.toolkitModuleId).toBe("tool-keep");
    expect(read.isOmniscient).toBe(true);
    expect(read.permissions).toEqual({ spawnAgents: true, patchRuntime: true, accessAllChannels: true });
  });

  it("scoped list returns only the requested workspace's agents", async () => {
    await localUpsertAgent(baseInput({ name: "a-ws-a", title: "A" }));
    await localUpsertAgent(baseInput({ workspaceId: "ws-b", name: "b-ws-b", title: "B" }));

    const scopedA = await localListAgents({ workspaceId: "ws-a" });
    expect(scopedA.map((r: any) => r.name)).toEqual(["a-ws-a"]);

    const scopedB = await localListAgents({ workspaceId: "ws-b" });
    expect(scopedB.map((r: any) => r.name)).toEqual(["b-ws-b"]);
  });
});
