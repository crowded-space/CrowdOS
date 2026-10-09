import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Hermetic by construction: no `__SOCKET_FAKE_DB__` flag, so the REAL database
// module loads and `isDatabaseConfigured()` is false (the loaded .env defines no
// DATABASE_URL). That is what puts every resolver on the local-first branch —
// the branch the desktop actually runs. A registry file + localstore dir per
// test keeps both the workspace records and the channel/category rows private.
const TEST_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "crowdos-mountgate-")));
const TEST_REGISTRY = join(TEST_ROOT, "workspaces.json");
const TEST_LOCALSTORE = join(TEST_ROOT, "localstore");
const TEST_SANDBOX = join(TEST_ROOT, "sandbox");
const TEST_HOME = join(TEST_ROOT, "home");
const REPO_DIR = join(TEST_HOME, "repo-a");
const CHANNEL_REPO = join(TEST_HOME, "repo-channel");

import { channelMountGate } from "./channel-mount-gate.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { channelMountRoutes } from "../routes/channel-mounts.js";
import { filesystemRoutes } from "../routes/filesystem.js";
import { validatorCompiler } from "../shared/core/validation.js";

type Row = Record<string, unknown>;

/**
 * Case-insensitive, separator-insensitive path equality. Windows drive letters
 * vary in case, and `attachWorkspace` deliberately persists forward slashes, so
 * raw string equality would fail on the platform the desktop actually ships on.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function writeJson(name: string, rows: Row[]): void {
  // Canon: categories/channels live at <workspaceFolder>/vfs/.crowdos/. An
  // unscoped row belongs to the documented "default" workspace folder.
  const crowdos = localStoreDirsForTests().crowdos;
  mkdirSync(crowdos, { recursive: true });
  writeFileSync(join(crowdos, name), JSON.stringify(rows, null, 2), "utf8");
}

function writeWorkspaces(records: Row[]): void {
  writeFileSync(TEST_REGISTRY, JSON.stringify({ workspaces: records }, null, 2), "utf8");
}

function workspaceRecord(id: string, extra: Row = {}): Row {
  return {
    id,
    name: id,
    icon: "box",
    databaseUrl: "",
    rootPath: join(TEST_SANDBOX, id),
    screenLockPinHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function channelRow(id: string, extra: Row = {}): Row {
  return {
    id,
    categoryId: null,
    workspaceId: null,
    folderPath: null,
    name: id,
    type: "text",
    createdBy: "system",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    archivedReason: null,
    ...extra,
  };
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  await channelMountRoutes(app);
  await filesystemRoutes(app);
  await app.ready();
  return app;
}

describe("channelMountGate", () => {
  const prevWorkspaceDir = process.env.WORKSPACE_DIR;

  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(REPO_DIR, { recursive: true });
    mkdirSync(CHANNEL_REPO, { recursive: true });
    mkdirSync(TEST_SANDBOX, { recursive: true });
    // The jail default is `[sandboxBase, os.homedir()]`. Pinning the sandbox
    // base to TEST_ROOT keeps every fixture inside the default jail on every
    // platform (tmpdir is NOT under $HOME on Linux/macOS) while leaving the
    // developer's real machine layout untouched.
    process.env.WORKSPACE_DIR = TEST_ROOT;
    // Store scope FIRST: the canon layout is derived from it, so the fixture
    // writes below must resolve against TEST_ROOT rather than the real sandbox.
    setLocalStoreDirForTests(TEST_LOCALSTORE);
    writeWorkspaces([]);
    writeJson("categories.json", []);
    writeJson("channels.json", []);
    setRegistryFilePathForTests(TEST_REGISTRY);
  });

  afterEach(() => {
    setRegistryFilePathForTests(null);
    setLocalStoreDirForTests(null);
    if (prevWorkspaceDir !== undefined) process.env.WORKSPACE_DIR = prevWorkspaceDir;
    else delete process.env.WORKSPACE_DIR;
  });

  // ─── Jail: registry-backed, no env read ──────────────────────────────

  describe("allowedRoots", () => {
    it("defaults to sandbox + home", async () => {
      const roots = await channelMountGate.allowedRoots(null);
      expect(Array.isArray(roots)).toBe(true);
      expect(roots).toContain(TEST_ROOT);
      // os.homedir() is the real home here — assert shape, not a fake path.
      expect(roots.length).toBeGreaterThanOrEqual(1);
    });

    it("prefers the workspace record's allowedMountRoots", async () => {
      writeWorkspaces([workspaceRecord("ws-jail", { allowedMountRoots: [REPO_DIR] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const roots = await channelMountGate.allowedRoots("ws-jail");
      expect(roots).toEqual([REPO_DIR]);
    });

    it("ignores an empty/blank allowedMountRoots and falls back to the default policy", async () => {
      writeWorkspaces([workspaceRecord("ws-blank", { allowedMountRoots: ["  "] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const roots = await channelMountGate.allowedRoots("ws-blank");
      expect(roots).toContain(TEST_ROOT);
    });

    it("no longer reads ALLOWED_MOUNT_ROOTS from the environment", async () => {
      const envJail = join(TEST_ROOT, "env-jail");
      process.env.ALLOWED_MOUNT_ROOTS = envJail;
      try {
        const roots = await channelMountGate.allowedRoots(null);
        expect(roots).not.toContain(envJail);
      } finally {
        delete process.env.ALLOWED_MOUNT_ROOTS;
      }
    });
  });

  describe("validate", () => {
    it("accepts a directory inside the jail and returns its realpath", async () => {
      const res = await channelMountGate.validate(REPO_DIR);
      expect(res.valid).toBe(true);
      expect(samePath(res.resolved!, REPO_DIR)).toBe(true);
    });

    it("rejects an empty path", async () => {
      await expect(channelMountGate.validate("")).resolves.toEqual({
        valid: false,
        error: "Path required",
      });
      await expect(channelMountGate.validate("   ")).resolves.toEqual({
        valid: false,
        error: "Path required",
      });
    });

    it("rejects a path containing a null byte without touching the disk", async () => {
      const res = await channelMountGate.validate(`${REPO_DIR}\0x`);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Invalid path");
    });

    it("rejects a non-existent directory", async () => {
      const res = await channelMountGate.validate(join(TEST_HOME, "nope-xyz-999"));
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Path does not exist");
    });

    it("rejects a file", async () => {
      const file = join(TEST_HOME, "a-file.txt");
      writeFileSync(file, "x", "utf8");
      const res = await channelMountGate.validate(file);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Path is not a directory");
    });

    it("rejects a directory outside the jail and names the roots", async () => {
      writeWorkspaces([workspaceRecord("ws-narrow", { allowedMountRoots: [TEST_SANDBOX] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const res = await channelMountGate.validate(REPO_DIR, "ws-narrow");
      expect(res.valid).toBe(false);
      expect(res.error).toBe(`Path outside allowed roots: ${TEST_SANDBOX}`);
    });

    it("refuses the workspace config sandbox (vfs/) even inside the jail", async () => {
      // Canon: vfs/ is the workspace's own runtime state, never a mount target.
      const workspaceFolder = join(TEST_SANDBOX, "CrowdOS Nightly");
      const vfs = join(workspaceFolder, "vfs");
      const artifacts = join(vfs, "artifacts");
      mkdirSync(join(vfs, ".crowdos"), { recursive: true });
      mkdirSync(artifacts, { recursive: true });
      writeWorkspaces([workspaceRecord("ws-vfs", { allowedMountRoots: [TEST_SANDBOX] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);

      for (const target of [vfs, artifacts]) {
        const res = await channelMountGate.validate(target, "ws-vfs");
        expect(res.valid).toBe(false);
        expect(res.error).toContain("workspace config sandbox");
      }
    });

    it("still mounts a normal folder that merely has a vfs-named sibling", async () => {
      // A user repository may contain a directory called vfs/; without the
      // workspace marker (vfs/.crowdos or a sibling workspace.json) it is
      // ordinary content and stays mountable.
      const plain = join(TEST_HOME, "plain-vfs");
      mkdirSync(join(plain, "vfs"), { recursive: true });
      const res = await channelMountGate.validate(join(plain, "vfs"));
      expect(res.valid).toBe(true);
    });
  });

  // ─── The resolver: Zone B wins, Zone A is named honestly ─────────────

  describe("resolveEffectiveRoot", () => {
    it("falls back to Zone A with source 'workspace-local' when nothing is mounted", async () => {
      writeWorkspaces([workspaceRecord("ws-plain")]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ workspaceId: "ws-plain" });
      expect(root.zone).toBe("workspace-local");
      expect(root.source).toBe("workspace-local");
      expect(samePath(root.path, join(TEST_SANDBOX, "ws-plain"))).toBe(true);
      expect(root.reason).toBeNull();
    });

    it("returns Zone B when a workspace mount resolves", async () => {
      writeWorkspaces([workspaceRecord("ws-mounted", { mountPath: REPO_DIR })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ workspaceId: "ws-mounted" });
      expect(root.zone).toBe("mounted");
      expect(root.source).toBe("workspace");
      expect(root.reason).toBeNull();
      expect(samePath(root.path, REPO_DIR)).toBe(true);
    });

    it("prefers the channel mount over the workspace mount", async () => {
      writeWorkspaces([workspaceRecord("ws-chain", { mountPath: REPO_DIR })]);
      writeJson("channels.json", [
        channelRow("ch-chain", { workspaceId: "ws-chain", folderPath: CHANNEL_REPO }),
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ channelId: "ch-chain" });
      expect(root.zone).toBe("mounted");
      expect(root.source).toBe("channel");
      expect(samePath(root.path, CHANNEL_REPO)).toBe(true);
    });

    it("prefers the category mount over the workspace mount", async () => {
      const categoryRepo = join(TEST_HOME, "repo-category");
      mkdirSync(categoryRepo, { recursive: true });
      writeWorkspaces([workspaceRecord("ws-cat", { mountPath: REPO_DIR })]);
      writeJson("categories.json", [
        {
          id: "cat-1",
          name: "Team",
          workspaceId: "ws-cat",
          folderPath: categoryRepo,
          ownedByAgentId: null,
          embeddingProfileId: null,
          createdBy: "system",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      writeJson("channels.json", [channelRow("ch-cat", { workspaceId: "ws-cat", categoryId: "cat-1" })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ channelId: "ch-cat" });
      expect(root.zone).toBe("mounted");
      expect(root.source).toBe("category");
      expect(samePath(root.path, categoryRepo)).toBe(true);
    });

    it("inherits the workspace mount through the category when both are unset", async () => {
      writeWorkspaces([workspaceRecord("ws-inherit", { mountPath: REPO_DIR })]);
      writeJson("categories.json", [
        {
          id: "cat-2",
          name: "Team",
          workspaceId: "ws-inherit",
          folderPath: null,
          ownedByAgentId: null,
          embeddingProfileId: null,
          createdBy: "system",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      writeJson("channels.json", [
        channelRow("ch-inherit", { workspaceId: "ws-inherit", categoryId: "cat-2" }),
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const info = await channelMountGate.resolve("ch-inherit");
      expect(info.source).toBe("workspace");
      const root = await channelMountGate.effectiveRoot({ channelId: "ch-inherit" });
      expect(root.zone).toBe("mounted");
      expect(root.source).toBe("workspace");
    });

    it("carries the reason when a configured mount is missing", async () => {
      writeWorkspaces([
        workspaceRecord("ws-broken", { mountPath: join(TEST_HOME, "deleted-repo") }),
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ workspaceId: "ws-broken" });
      expect(root.zone).toBe("workspace-local");
      expect(root.reason).toBe("Path does not exist");
      expect(samePath(root.path, join(TEST_SANDBOX, "ws-broken"))).toBe(true);
    });

    it("carries the reason when a configured mount is outside the jail", async () => {
      writeWorkspaces([
        workspaceRecord("ws-outside", {
          mountPath: REPO_DIR,
          allowedMountRoots: [TEST_SANDBOX],
        }),
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ workspaceId: "ws-outside" });
      expect(root.zone).toBe("workspace-local");
      expect(root.reason).toBe(`Path outside allowed roots: ${TEST_SANDBOX}`);
    });

    it("returns the sandbox base when given no ids at all", async () => {
      const root = await channelMountGate.effectiveRoot({});
      expect(root.zone).toBe("workspace-local");
      expect(samePath(root.path, TEST_ROOT)).toBe(true);
    });

    it("trusts the channel's workspace when the caller passes none", async () => {
      writeWorkspaces([workspaceRecord("ws-from-channel")]);
      writeJson("channels.json", [channelRow("ch-ws", { workspaceId: "ws-from-channel" })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const root = await channelMountGate.effectiveRoot({ channelId: "ch-ws" });
      expect(root.zone).toBe("workspace-local");
      expect(samePath(root.path, join(TEST_SANDBOX, "ws-from-channel"))).toBe(true);
    });
  });

  describe("resolveMountScope", () => {
    it("adds the Zone A sibling and the display name", async () => {
      writeWorkspaces([workspaceRecord("ws-scope", { mountPath: REPO_DIR })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const scope = await channelMountGate.scope({ workspaceId: "ws-scope" });
      expect(scope.zone).toBe("mounted");
      expect(scope.displayName).toBe("repo-a");
      expect(samePath(scope.workspaceRoot, join(TEST_SANDBOX, "ws-scope"))).toBe(true);
    });

    it("displayName is the workspace dir when nothing is mounted", async () => {
      writeWorkspaces([workspaceRecord("ws-name")]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const scope = await channelMountGate.scope({ workspaceId: "ws-name" });
      expect(scope.displayName).toBe("ws-name");
      expect(scope.zone).toBe("workspace-local");
    });
  });

  // ─── Phase-1 exit criterion: panel root === agent tool root ──────────

  describe("panel/tool agreement", () => {
    it("scope().path equals resolveToolRoot() for the same (workspaceId, channelId)", async () => {
      const { resolveToolRoot } = await import("../tools/tool-registry.js");
      writeWorkspaces([workspaceRecord("ws-agree", { mountPath: REPO_DIR })]);
      writeJson("channels.json", [channelRow("ch-agree", { workspaceId: "ws-agree" })]);
      setRegistryFilePathForTests(TEST_REGISTRY);

      const scope = await channelMountGate.scope({
        workspaceId: "ws-agree",
        channelId: "ch-agree",
      });
      const toolRoot = await resolveToolRoot({ workspaceId: "ws-agree", channelId: "ch-agree" });

      expect(scope.zone).toBe("mounted");
      expect(samePath(toolRoot, scope.path)).toBe(true);
    });

    it("agrees on the Zone A fallback too", async () => {
      const { resolveToolRoot } = await import("../tools/tool-registry.js");
      writeWorkspaces([workspaceRecord("ws-agree-local")]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const scope = await channelMountGate.scope({ workspaceId: "ws-agree-local" });
      const toolRoot = await resolveToolRoot({ workspaceId: "ws-agree-local" });
      expect(scope.zone).toBe("workspace-local");
      expect(samePath(toolRoot, scope.path)).toBe(true);
    });
  });

  // ─── browse: the picker's own jail ───────────────────────────────────

  describe("browse", () => {
    it("lists a directory dirs-first with absolute entry paths", async () => {
      mkdirSync(join(REPO_DIR, "zeta-dir"), { recursive: true });
      writeFileSync(join(REPO_DIR, "alpha.txt"), "a", "utf8");
      const res = await channelMountGate.browse(REPO_DIR);
      expect(samePath(res.path, REPO_DIR)).toBe(true);
      expect(Array.isArray(res.allowedRoots)).toBe(true);
      const names = res.entries.map((e) => e.name);
      expect(names.indexOf("zeta-dir")).toBeLessThan(names.indexOf("alpha.txt"));
      expect(res.entries.find((e) => e.name === "alpha.txt")?.path).toContain("alpha.txt");
    });

    it("hides dotfiles except the three repo markers", async () => {
      mkdirSync(join(REPO_DIR, ".git"), { recursive: true });
      mkdirSync(join(REPO_DIR, ".crowdos"), { recursive: true });
      mkdirSync(join(REPO_DIR, ".ThisCrowd"), { recursive: true });
      writeFileSync(join(REPO_DIR, ".crowdosrc"), "{}", "utf8");
      const res = await channelMountGate.browse(REPO_DIR);
      const names = res.entries.map((e) => e.name);
      expect(names).not.toContain(".git");
      expect(names).toContain(".crowdos");
      expect(names).toContain(".ThisCrowd");
      expect(names).toContain(".crowdosrc");
    });

    it("clamps a path outside the jail back to the first allowed root", async () => {
      writeWorkspaces([workspaceRecord("ws-clamp", { allowedMountRoots: [TEST_SANDBOX] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const res = await channelMountGate.browse(REPO_DIR, "ws-clamp");
      expect(samePath(res.path, TEST_SANDBOX)).toBe(true);
    });

    it("throws for a missing directory instead of returning an empty listing", async () => {
      await expect(channelMountGate.browse(join(TEST_HOME, "gone-xyz"))).rejects.toThrow(
        /Path does not exist/,
      );
    });

    it("nulls parent when the parent sits outside the jail", async () => {
      // Narrow jail: TEST_SANDBOX's parent (TEST_ROOT) is now out of bounds, so
      // the picker must not offer to walk above the root it was given.
      writeWorkspaces([workspaceRecord("ws-edge", { allowedMountRoots: [TEST_SANDBOX] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const res = await channelMountGate.browse(TEST_SANDBOX, "ws-edge");
      expect(samePath(res.path, TEST_SANDBOX)).toBe(true);
      expect(res.parent).toBeNull();
    });

    it("offers a parent inside the jail for a nested directory", async () => {
      const res = await channelMountGate.browse(REPO_DIR);
      expect(res.parent).not.toBeNull();
    });
  });

  // ─── attach: local-first writes Zone B, never Zone A ────────────────

  describe("attach", () => {
    it("writes mountPath on the record and leaves rootPath untouched", async () => {
      const zoneA = join(TEST_SANDBOX, "ws-attach");
      writeWorkspaces([workspaceRecord("ws-attach")]);
      setRegistryFilePathForTests(TEST_REGISTRY);

      const res = await channelMountGate.attachWorkspace("ws-attach", REPO_DIR);
      expect(res.ok).toBe(true);

      const { getWorkspaceRecord } = await import("../workspace/workspace-registry.js");
      const record = await getWorkspaceRecord("ws-attach");
      expect(record?.mountPath).toBeDefined();
      expect(samePath(record!.mountPath!, REPO_DIR)).toBe(true);
      // Persisted form is slashed — the panel and the tools both read this
      // value, so a backslash form would show up as a different string in the
      // header than the folder the user picked.
      expect(record!.mountPath!).not.toContain("\\");
      expect(samePath(record!.rootPath, zoneA)).toBe(true);
    });

    it("clearing the mount nulls mountPath and keeps rootPath", async () => {
      writeWorkspaces([workspaceRecord("ws-clear", { mountPath: REPO_DIR })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const res = await channelMountGate.attachWorkspace("ws-clear", null);
      expect(res.ok).toBe(true);

      const { getWorkspaceRecord } = await import("../workspace/workspace-registry.js");
      const record = await getWorkspaceRecord("ws-clear");
      expect(record?.mountPath).toBeNull();
      expect(samePath(record!.rootPath, join(TEST_SANDBOX, "ws-clear"))).toBe(true);
    });

    it("refuses a path outside the jail", async () => {
      writeWorkspaces([workspaceRecord("ws-refuse", { allowedMountRoots: [TEST_SANDBOX] })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const res = await channelMountGate.attachWorkspace("ws-refuse", REPO_DIR);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe(`Path outside allowed roots: ${TEST_SANDBOX}`);
    });

    it("attaches a channel mount and reads it back through the resolver", async () => {
      writeWorkspaces([workspaceRecord("ws-ch-attach")]);
      writeJson("channels.json", [channelRow("ch-attach", { workspaceId: "ws-ch-attach" })]);
      setRegistryFilePathForTests(TEST_REGISTRY);

      const res = await channelMountGate.attachChannel("ch-attach", REPO_DIR);
      expect(res.ok).toBe(true);

      const info = await channelMountGate.resolve("ch-attach");
      expect(info.source).toBe("channel");
      expect(samePath(info.mountedPath!, REPO_DIR)).toBe(true);
    });

    it("attaches a category mount and reads it back through the resolver", async () => {
      writeWorkspaces([workspaceRecord("ws-cat-attach")]);
      writeJson("categories.json", [
        {
          id: "cat-attach",
          name: "Team",
          workspaceId: "ws-cat-attach",
          folderPath: null,
          ownedByAgentId: null,
          embeddingProfileId: null,
          createdBy: "system",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);

      const res = await channelMountGate.attachCategory("cat-attach", REPO_DIR);
      expect(res.ok).toBe(true);

      const info = await channelMountGate.resolveCategory("cat-attach");
      expect(info.source).toBe("category");
      expect(samePath(info.mountedPath!, REPO_DIR)).toBe(true);
    });
  });

  // ─── Routes ──────────────────────────────────────────────────────────

  describe("routes", () => {
    it("GET /api/fs/allowed-roots returns the jail", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/fs/allowed-roots" });
      expect(res.statusCode).toBe(200);
      expect(res.json().roots).toContain(TEST_ROOT);
      await app.close();
    });

    it("GET /api/fs/browse lists a directory", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/fs/browse?path=${encodeURIComponent(REPO_DIR)}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.entries)).toBe(true);
      expect(Array.isArray(data.allowedRoots)).toBe(true);
      await app.close();
    });

    it("POST /api/fs/pick-folder is 410 Gone", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/fs/pick-folder",
        payload: { initialPath: REPO_DIR },
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe("Gone");
      await app.close();
    });

    it("GET /api/workspace/mount returns the MountScope the panel renders", async () => {
      writeWorkspaces([workspaceRecord("ws-route", { mountPath: REPO_DIR })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/workspace/mount?workspaceId=ws-route",
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.zone).toBe("mounted");
      expect(data.source).toBe("workspace");
      expect(data.displayName).toBe("repo-a");
      expect(samePath(data.workspaceRoot, join(TEST_SANDBOX, "ws-route"))).toBe(true);
      await app.close();
    });

    it("GET /api/workspace/mount explains an unusable mount with a reason", async () => {
      writeWorkspaces([
        workspaceRecord("ws-route-bad", { mountPath: join(TEST_HOME, "gone-repo") }),
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/workspace/mount?workspaceId=ws-route-bad",
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.zone).toBe("workspace-local");
      expect(data.reason).toBe("Path does not exist");
      await app.close();
    });

    it("GET /api/workspace/files returns scope + nodes at the root and a bare array below", async () => {
      writeWorkspaces([workspaceRecord("ws-files", { mountPath: REPO_DIR })]);
      mkdirSync(join(REPO_DIR, "src"), { recursive: true });
      writeFileSync(join(REPO_DIR, "README.md"), "# hi", "utf8");
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();

      const root = await app.inject({
        method: "GET",
        url: "/api/workspace/files?path=/&workspaceId=ws-files",
      });
      expect(root.statusCode).toBe(200);
      const rootData = root.json();
      expect(rootData.zone).toBe("mounted");
      expect(rootData.displayName).toBe("repo-a");
      expect(Array.isArray(rootData.nodes)).toBe(true);
      expect(rootData.nodes.map((n: Row) => n.name)).toContain("README.md");

      const nested = await app.inject({
        method: "GET",
        url: "/api/workspace/files?path=/src&workspaceId=ws-files",
      });
      expect(nested.statusCode).toBe(200);
      expect(Array.isArray(nested.json())).toBe(true);
      await app.close();
    });

    it("PUT then GET /api/workspaces/:id/mount round-trips and reports source", async () => {
      writeWorkspaces([workspaceRecord("ws-put")]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();

      const put = await app.inject({
        method: "PUT",
        url: "/api/workspaces/ws-put/mount",
        payload: { folderPath: REPO_DIR },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().source).toBe("workspace");

      const get = await app.inject({ method: "GET", url: "/api/workspaces/ws-put/mount" });
      expect(get.statusCode).toBe(200);
      expect(samePath(get.json().mountedPath, REPO_DIR)).toBe(true);
      await app.close();
    });

    it("PUT /api/workspaces/:id/mount rejects an unusable path with 400", async () => {
      writeWorkspaces([workspaceRecord("ws-put-bad")]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/workspaces/ws-put-bad/mount",
        payload: { folderPath: join(TEST_HOME, "missing-xyz") },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe("Path does not exist");
      await app.close();
    });

    it("PUT /api/channels/:id/mount round-trips", async () => {
      writeWorkspaces([workspaceRecord("ws-ch-route")]);
      writeJson("channels.json", [channelRow("ch-route", { workspaceId: "ws-ch-route" })]);
      setRegistryFilePathForTests(TEST_REGISTRY);
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/channels/ch-route/mount",
        payload: { folderPath: REPO_DIR },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe("channel");
      await app.close();
    });
  });

  // ─── CM-003: caller-vs-target ownership on mount routes ─────────────

  describe("CM-003 ownership", () => {
    async function buildAppAs(wsId: string | null) {
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      if (wsId) {
        // Mirrors the real tenant hook in create-app.ts: x-workspace-id →
        // request.workspaceId. No header means no scope to compare (the
        // keyless loopback desktop path).
        app.addHook("onRequest", async (request) => {
          (request as any).workspaceId = wsId;
        });
      }
      await channelMountRoutes(app);
      await filesystemRoutes(app);
      await app.ready();
      return app;
    }

    function seedTwoWorkspaces(): void {
      writeWorkspaces([
        workspaceRecord("ws-a", { allowedMountRoots: [REPO_DIR] }),
        workspaceRecord("ws-b", { allowedMountRoots: [REPO_DIR] }),
      ]);
      writeJson("channels.json", [channelRow("ch-a", { workspaceId: "ws-a" })]);
      writeJson("categories.json", [
        {
          id: "cat-a",
          name: "Team",
          workspaceId: "ws-a",
          folderPath: null,
          ownedByAgentId: null,
          embeddingProfileId: null,
          createdBy: "system",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      setRegistryFilePathForTests(TEST_REGISTRY);
    }

    it("T5: cross-workspace GET/PUT on channel, category and workspace mount routes → 403 (own → 200)", async () => {
      seedTwoWorkspaces();
      const app = await buildAppAs("ws-b");

      for (const url of [
        "/api/channels/ch-a/mount",
        "/api/categories/cat-a/mount",
        "/api/workspaces/ws-a/mount",
      ]) {
        const get = await app.inject({ method: "GET", url });
        expect(get.statusCode, `GET ${url}`).toBe(403);
        const put = await app.inject({ method: "PUT", url, payload: { folderPath: REPO_DIR } });
        expect(put.statusCode, `PUT ${url}`).toBe(403);
      }

      // The denied PUT must not have written the mount column.
      const rows = JSON.parse(
        readFileSync(join(localStoreDirsForTests().crowdos, "channels.json"), "utf8"),
      ) as Row[];
      expect(rows.find((r) => r.id === "ch-a")?.folderPath ?? null).toBeNull();

      await app.close();

      // The owning workspace keeps full access on the same routes.
      const owner = await buildAppAs("ws-a");
      const ownPut = await owner.inject({
        method: "PUT",
        url: "/api/channels/ch-a/mount",
        payload: { folderPath: REPO_DIR },
      });
      expect(ownPut.statusCode).toBe(200);
      expect(ownPut.json().source).toBe("channel");
      const ownGet = await owner.inject({ method: "GET", url: "/api/channels/ch-a/mount" });
      expect(ownGet.statusCode).toBe(200);
      expect(samePath(ownGet.json().mountedPath, REPO_DIR)).toBe(true);
      await owner.close();
    });

    it("T5: cross-workspace browse/allowed-roots → 403; a scoped caller falls back to its own jail", async () => {
      seedTwoWorkspaces();
      const app = await buildAppAs("ws-b");

      const crossRoots = await app.inject({ method: "GET", url: "/api/fs/allowed-roots?workspaceId=ws-a" });
      expect(crossRoots.statusCode).toBe(403);
      const crossBrowse = await app.inject({
        method: "GET",
        url: `/api/fs/browse?workspaceId=ws-a&path=${encodeURIComponent(REPO_DIR)}`,
      });
      expect(crossBrowse.statusCode).toBe(403);

      // Same caller, own id → 200 with its own jail.
      const ownRoots = await app.inject({ method: "GET", url: "/api/fs/allowed-roots?workspaceId=ws-b" });
      expect(ownRoots.statusCode).toBe(200);
      expect(ownRoots.json().roots).toEqual([REPO_DIR]);

      // Scoped caller with NO query param → its own jail, never sandbox+home.
      const scopedRoots = await app.inject({ method: "GET", url: "/api/fs/allowed-roots" });
      expect(scopedRoots.statusCode).toBe(200);
      expect(scopedRoots.json().roots).toEqual([REPO_DIR]);

      // Unscoped caller (no tenant scope) keeps the documented default policy.
      await app.close();
      const anon = await buildAppAs(null);
      const anonRoots = await anon.inject({ method: "GET", url: "/api/fs/allowed-roots" });
      expect(anonRoots.statusCode).toBe(200);
      expect(anonRoots.json().roots).toContain(TEST_ROOT);
      await anon.close();
    });
  });
});
