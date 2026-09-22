// ─── Canon workspace storage layout (mock-structure-polished) ─────────
// Pins the on-disk contract the desktop ships, requirement by requirement:
//
//   <sandboxBase>/<folderName>/
//     workspace.json                 singular record, rootPath "."
//     vfs/.crowdos/workspace.json    runtime only (artifactDir + fsMounts)
//     vfs/.crowdos/categories.json   ONLY place for categories
//     vfs/.crowdos/channels.json     ONLY place for channels
//     vfs/agents/<agentId>.json      one file per agent, single object
//     vfs/artifacts/                 plain files, no index
//     vfs/src/
//
// The global workspaces.json stays the portal/hub index and wins on load; the
// folder copy is a mirror rewritten from it. `vfs/` is a config sandbox and is
// never a mount target.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_SCOPE,
  localStoreDirsForTests,
  resolveLocalStoreDir,
  resolveWorkspaceAgentsDir,
  resolveWorkspaceArtifactsDir,
  resolveWorkspaceFolderSync,
  setLocalStoreDirForTests,
} from "../shared/core/local-file.js";
import { localSeedDefaultAgent, localGetAgent, localListAgents } from "../agents/agent-local-store.js";
import {
  localCreateCategory,
  localCreateChannel,
  localListCategories,
  localListChannels,
} from "../channels/channel-local-store.js";
import {
  defaultWorkspaceRuntimeConfig,
  readWorkspaceRuntimeConfig,
  writeWorkspaceRuntimeConfig,
} from "./workspace-runtime.js";
import {
  DEFAULT_ARTIFACT_DIR,
  normalizeArtifactDir,
  resolveArtifactsDir,
  resolveCrowdosDir,
  resolveVfsDir,
  sanitizeWorkspaceFolderName,
  toFolderRelative,
} from "./workspace-paths.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "crowdos-canon-"));
  setLocalStoreDirForTests(base);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(base, { recursive: true, force: true });
  };
});

afterEach(() => {
  setLocalStoreDirForTests(null);
});

describe("canon folder names", () => {
  it("keeps a display name browsable instead of slugging it", () => {
    expect(sanitizeWorkspaceFolderName("CrowdOS Nightly")).toBe("CrowdOS Nightly");
  });

  it("strips characters a filesystem cannot hold", () => {
    expect(sanitizeWorkspaceFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    expect(sanitizeWorkspaceFolderName("trailing dots...")).toBe("trailing dots");
  });

  it("refuses to collide with the global index file", () => {
    expect(sanitizeWorkspaceFolderName("workspaces.json")).toBe("workspace");
  });

  it("escapes Windows device names", () => {
    expect(sanitizeWorkspaceFolderName("con")).toBe("con-workspace");
    expect(sanitizeWorkspaceFolderName("NUL")).toBe("NUL-workspace");
  });

  it("falls back to a usable name for empty or whitespace input", () => {
    expect(sanitizeWorkspaceFolderName("")).toBe("workspace");
    expect(sanitizeWorkspaceFolderName("   ")).toBe("workspace");
  });
});

describe("canon path helpers", () => {
  it("derives vfs, .crowdos and agents from the workspace folder", () => {
    const folder = join(base, "CrowdOS Nightly");
    expect(resolveVfsDir(folder)).toBe(join(folder, "vfs"));
    expect(resolveCrowdosDir(folder)).toBe(join(folder, "vfs", ".crowdos"));
    expect(resolveWorkspaceAgentsDir("ws-1")).toBe(join(resolveWorkspaceFolderSync("ws-1"), "vfs", "agents"));
  });

  it("defaults artifactDir to vfs/artifacts and refuses to escape the folder", () => {
    const folder = join(base, "ws");
    expect(normalizeArtifactDir(null)).toBe(DEFAULT_ARTIFACT_DIR);
    expect(resolveArtifactsDir(folder, null)).toBe(join(folder, "vfs", "artifacts"));
    // Absolute and traversal forms fall back to the canon default rather than
    // letting generation write outside the workspace folder.
    expect(normalizeArtifactDir("C:/elsewhere")).toBe(DEFAULT_ARTIFACT_DIR);
    expect(normalizeArtifactDir("../../etc")).toBe(DEFAULT_ARTIFACT_DIR);
    expect(resolveArtifactsDir(folder, "/tmp/evil")).toBe(join(folder, "vfs", "artifacts"));
  });

  it("expresses absolute artifact paths folder-relatively for DB rows", () => {
    const folder = join(base, "ws");
    const file = join(folder, "vfs", "artifacts", "run-1", "art_x.md");
    expect(toFolderRelative(file, folder)).toBe("vfs/artifacts/run-1/art_x.md");
  });
});

describe("canon per-workspace store scoping", () => {
  it("scopes the store root to <folder>/vfs/.crowdos", () => {
    expect(resolveLocalStoreDir("ws-1")).toBe(join(base, "ws-1", "vfs", ".crowdos"));
    expect(resolveLocalStoreDir(null)).toBe(join(base, DEFAULT_WORKSPACE_SCOPE, "vfs", ".crowdos"));
  });

  it("keeps two workspaces in separate folders, never one shared file", async () => {
    await localCreateCategory({ name: "General", workspaceId: "ws-a", createdBy: "system" });
    await localCreateCategory({ name: "General", workspaceId: "ws-b", createdBy: "system" });

    expect(existsSync(join(localStoreDirsForTests("ws-a").crowdos, "categories.json"))).toBe(true);
    expect(existsSync(join(localStoreDirsForTests("ws-b").crowdos, "categories.json"))).toBe(true);
    expect(existsSync(join(base, "localstore"))).toBe(false);

    const a = await localListCategories("ws-a");
    const b = await localListCategories("ws-b");
    expect(a.map((c) => c.workspaceId)).toEqual(["ws-a"]);
    expect(b.map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  it("writes categories and channels into vfs/.crowdos, not the folder root", async () => {
    const cat = await localCreateCategory({ name: "General", workspaceId: "ws-1", createdBy: "system" });
    await localCreateChannel({
      name: "general", type: "standard", createdBy: "system",
      categoryId: cat.id, workspaceId: "ws-1",
    });

    const dirs = localStoreDirsForTests("ws-1");
    expect(existsSync(join(dirs.crowdos, "categories.json"))).toBe(true);
    expect(existsSync(join(dirs.crowdos, "channels.json"))).toBe(true);
    // Nothing landed at the workspace folder root or in vfs/.
    expect(existsSync(join(dirs.workspaceFolder, "categories.json"))).toBe(false);
    expect(existsSync(join(resolveVfsDir(dirs.workspaceFolder), "channels.json"))).toBe(false);

    expect((await localListChannels({ workspaceId: "ws-1" })).map((c) => c.name)).toEqual(["general"]);
  });
});

describe("canon agent storage: one file per agent", () => {
  it("writes <agentId>.json and reads it back by id", async () => {
    const agent = await localSeedDefaultAgent("ws-1");
    const file = join(resolveWorkspaceAgentsDir("ws-1"), agent.id + ".json");
    expect(existsSync(file)).toBe(true);

    const raw = JSON.parse(readFileSync(file, "utf8"));
    // A single OBJECT per file (never a one-entry array), and the filename
    // matches the id so the directory itself is the index.
    expect(Array.isArray(raw)).toBe(false);
    expect(raw.id).toBe(agent.id);
    expect(raw.workspaceId).toBe("ws-1");

    expect((await localGetAgent(agent.id, "ws-1"))?.id).toBe(agent.id);
  });

  it("is idempotent per workspace and does not duplicate the roster", async () => {
    const first = await localSeedDefaultAgent("ws-1");
    const again = await localSeedDefaultAgent("ws-1");
    expect(again.id).toBe(first.id);
    expect((await localListAgents({ workspaceId: "ws-1" })).length).toBe(1);
  });

  it("keeps rosters isolated per workspace", async () => {
    await localSeedDefaultAgent("ws-a");
    await localSeedDefaultAgent("ws-b");
    expect((await localListAgents({ workspaceId: "ws-a" })).length).toBe(1);
    expect((await localListAgents({ workspaceId: "ws-b" })).length).toBe(1);
    expect(existsSync(join(resolveWorkspaceAgentsDir("ws-a"), "agent-default-assistant.json"))).toBe(true);
    expect(existsSync(join(resolveWorkspaceAgentsDir("ws-b"), "agent-default-assistant.json"))).toBe(true);
  });
});

describe("canon runtime object (vfs/.crowdos/workspace.json)", () => {
  it("defaults to the canon shape: permissions, constraints, artifactDir, fsMounts", async () => {
    const cfg = defaultWorkspaceRuntimeConfig({ id: "ws-1", name: "Nightly" });
    expect(cfg.artifactDir).toBe("vfs/artifacts");
    expect(cfg.fsMounts).toEqual({ scope: "workspace", mode: "default", mounts: [] });
    expect(cfg.permissions).toEqual({ network: false, shell: false, maxAgents: 8 });
    expect(cfg.constraints.shellExecution).toBe(true);
  });

  it("round-trips through the canon file with a workspace wrapper", async () => {
    const written = await writeWorkspaceRuntimeConfig("ws-1", {
      name: "Nightly",
      artifactDir: "vfs/artifacts",
      fsMounts: {
        scope: "workspace",
        mode: "default",
        mounts: [{ id: "ws-repo", source: "/workspace/repository", target: "/mnt/repository", type: "repository", readOnly: false }],
      },
    });
    expect(written.fsMounts.mounts).toHaveLength(1);

    const file = join(resolveCrowdosDir(resolveWorkspaceFolderSync("ws-1")), "workspace.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // Canon wraps the object in { workspace: {...} } and never embeds
    // categories/channels (they own their own files next to it).
    expect(Object.keys(raw)).toEqual(["workspace"]);
    expect(raw.workspace.categories).toBeUndefined();
    expect(raw.workspace.channels).toBeUndefined();
    expect(raw.workspace.artifactDir).toBe("vfs/artifacts");

    const read = await readWorkspaceRuntimeConfig("ws-1");
    expect(read.fsMounts.mounts[0].target).toBe("/mnt/repository");
  });

  it("normalizes a malformed stored object back to canon defaults", async () => {
    const folder = resolveWorkspaceFolderSync("ws-1");
    const file = join(resolveCrowdosDir(folder), "workspace.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(resolveCrowdosDir(folder), { recursive: true });
    writeFileSync(file, JSON.stringify({ workspace: { artifactDir: "C:/evil", fsMounts: { mode: "nonsense" } } }), "utf8");

    const cfg = await readWorkspaceRuntimeConfig("ws-1");
    expect(cfg.artifactDir).toBe("vfs/artifacts");
    expect(cfg.fsMounts.mode).toBe("default");
    expect(cfg.fsMounts.mounts).toEqual([]);
  });
});
