// ─── Canon virtual mounts: inherit / override chain ───────────────────
// mock-structure-polished: a workspace declares mounts with mode "default";
// each category/channel either "inherit"s the parent level or "override"s it.
// Resolution walks channel → category → workspace and the FIRST override wins.
// Mounts are VIRTUAL paths (what the agent sees), and host mounts keep their
// own jail. `vfs/` is never a mount target.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { channelMountGate } from "../channel-mounts/channel-mount-gate.js";
import { writeWorkspaceRuntimeConfig } from "../workspace/workspace-runtime.js";

let base: string;
let registryFile: string;
let prevWorkspaceDir: string | undefined;

function writeJson(name: string, rows: unknown[]): void {
  const crowdos = join(base, "ws-1", "vfs", ".crowdos");
  mkdirSync(crowdos, { recursive: true });
  writeFileSync(join(crowdos, name), JSON.stringify(rows, null, 2), "utf8");
}

function writeRegistry(): void {
  writeFileSync(
    registryFile,
    JSON.stringify({
      workspaces: [
        {
          id: "ws-1",
          name: "CrowdOS Nightly",
          icon: "crow",
          databaseUrl: "",
          folderName: "CrowdOS Nightly",
          artifactDir: "vfs/artifacts",
          rootPath: join(base, "ws-1"),
          screenLockPinHash: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }, null, 2),
    "utf8",
  );
}

const WS_MOUNT = { id: "ws-repo", source: "/workspace/repository", target: "/mnt/repository", type: "repository", readOnly: false };
const CAT_MOUNT = { id: "cat-repo", source: "/repositories/backend", target: "/mnt/repository", type: "repository", readOnly: false };
const CH_MOUNT = { id: "ch-repo", source: "/repositories/experimental", target: "/mnt/repository", type: "repository", readOnly: true };

function category(extra: Record<string, unknown> = {}) {
  return {
    id: "cat-1",
    name: "Backend",
    workspaceId: "ws-1",
    folderPath: null,
    ownedByAgentId: null,
    embeddingProfileId: null,
    createdBy: "system",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    fsMounts: { scope: "category", mode: "inherit", mounts: [] },
    ...extra,
  };
}

function channel(extra: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    categoryId: "cat-1",
    workspaceId: "ws-1",
    folderPath: null,
    name: "backend-dev",
    type: "standard",
    createdBy: "system",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    archivedReason: null,
    fsMounts: { scope: "channel", mode: "inherit", mounts: [] },
    ...extra,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "crowdos-mountchain-"));
  registryFile = join(base, "workspaces.json");
  prevWorkspaceDir = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = base;
  setLocalStoreDirForTests(base);
  setRegistryFilePathForTests(registryFile);
  writeRegistry();
  writeJson("categories.json", []);
  writeJson("channels.json", []);
  return () => {
    setRegistryFilePathForTests(null);
    setLocalStoreDirForTests(null);
    if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevWorkspaceDir;
    rmSync(base, { recursive: true, force: true });
  };
});

afterEach(() => {
  setRegistryFilePathForTests(null);
  setLocalStoreDirForTests(null);
});

describe("canon virtual mount resolution", () => {
  it("returns the workspace default when no child overrides", async () => {
    await writeWorkspaceRuntimeConfig("ws-1", {
      name: "CrowdOS Nightly",
      fsMounts: { scope: "workspace", mode: "default", mounts: [WS_MOUNT] },
    });
    writeJson("categories.json", [category()]);
    writeJson("channels.json", [channel()]);

    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1", channelId: "ch-1" });
    expect(resolved.source).toBe("workspace");
    expect(resolved.mounts).toEqual([WS_MOUNT]);
  });

  it("lets a category override win over the workspace default", async () => {
    await writeWorkspaceRuntimeConfig("ws-1", {
      name: "CrowdOS Nightly",
      fsMounts: { scope: "workspace", mode: "default", mounts: [WS_MOUNT] },
    });
    writeJson("categories.json", [
      category({ fsMounts: { scope: "category", mode: "override", mounts: [CAT_MOUNT] } }),
    ]);
    writeJson("channels.json", [channel()]);

    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1", channelId: "ch-1" });
    expect(resolved.source).toBe("category");
    expect(resolved.mounts).toEqual([CAT_MOUNT]);
  });

  it("lets a channel override win over both parents", async () => {
    await writeWorkspaceRuntimeConfig("ws-1", {
      name: "CrowdOS Nightly",
      fsMounts: { scope: "workspace", mode: "default", mounts: [WS_MOUNT] },
    });
    writeJson("categories.json", [
      category({ fsMounts: { scope: "category", mode: "override", mounts: [CAT_MOUNT] } }),
    ]);
    writeJson("channels.json", [
      channel({ fsMounts: { scope: "channel", mode: "override", mounts: [CH_MOUNT] } }),
    ]);

    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1", channelId: "ch-1" });
    expect(resolved.source).toBe("channel");
    expect(resolved.mounts).toEqual([CH_MOUNT]);
  });

  it("skips inherit levels by definition", async () => {
    await writeWorkspaceRuntimeConfig("ws-1", {
      name: "CrowdOS Nightly",
      fsMounts: { scope: "workspace", mode: "default", mounts: [WS_MOUNT] },
    });
    // Both children say inherit and carry mounts that must NOT be used.
    writeJson("categories.json", [category({ fsMounts: { scope: "category", mode: "inherit", mounts: [CAT_MOUNT] } })]);
    writeJson("channels.json", [channel({ fsMounts: { scope: "channel", mode: "inherit", mounts: [CH_MOUNT] } })]);

    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1", channelId: "ch-1" });
    expect(resolved.source).toBe("workspace");
    expect(resolved.mounts).toEqual([WS_MOUNT]);
  });

  it("drops a mount missing a source or target instead of surfacing a phantom", async () => {
    await writeWorkspaceRuntimeConfig("ws-1", {
      name: "CrowdOS Nightly",
      fsMounts: {
        scope: "workspace",
        mode: "default",
        mounts: [WS_MOUNT, { id: "bad", source: "", target: "/mnt/x", type: "local", readOnly: false } as never],
      },
    });

    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1" });
    expect(resolved.mounts).toEqual([WS_MOUNT]);
  });

  it("reports none when nothing declared any mounts", async () => {
    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1" });
    expect(resolved.source).toBe("none");
    expect(resolved.mounts).toEqual([]);
  });

  it("stores a workspace mount set in the canon runtime object", async () => {
    const res = await channelMountGate.setEffectiveMounts({ workspaceId: "ws-1", mounts: [WS_MOUNT] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mounts.mode).toBe("default");
      expect(res.mounts.mounts).toEqual([WS_MOUNT]);
    }
    // Read back through the resolver, which is the only supported read path.
    const resolved = await channelMountGate.effectiveMounts({ workspaceId: "ws-1" });
    expect(resolved.mounts).toEqual([WS_MOUNT]);
  });

  it("stores a channel override on the channel row", async () => {
    writeJson("categories.json", [category()]);
    writeJson("channels.json", [channel()]);
    const res = await channelMountGate.setEffectiveMounts({ channelId: "ch-1", mounts: [CH_MOUNT] });
    expect(res.ok).toBe(true);
    const resolved = await channelMountGate.effectiveMounts({ channelId: "ch-1" });
    expect(resolved.source).toBe("channel");
    expect(resolved.mounts).toEqual([CH_MOUNT]);
  });

  it("stores a category override on the category row", async () => {
    writeJson("categories.json", [category()]);
    writeJson("channels.json", [channel()]);
    const res = await channelMountGate.setEffectiveMounts({ categoryId: "cat-1", mounts: [CAT_MOUNT] });
    expect(res.ok).toBe(true);
    const resolved = await channelMountGate.effectiveMounts({ channelId: "ch-1" });
    expect(resolved.source).toBe("category");
    expect(resolved.mounts).toEqual([CAT_MOUNT]);
  });

  it("refuses a channel id that does not exist", async () => {
    const res = await channelMountGate.setEffectiveMounts({ channelId: "ch-missing", mounts: [CH_MOUNT] });
    expect(res.ok).toBe(false);
  });
});
