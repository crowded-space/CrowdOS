// ─── Entry visibility — one listing rule for the tree and the picker ──
//
// entry-visibility.ts exists because the Repo tree and the mount picker used to
// answer "is this directory entry listed?" differently: the tree hid every
// dotfile, the picker un-hid the three repo markers. The same directory therefore
// had two contents depending on which surface asked, and a mounted repository
// looked empty of its own markers in the tree that was supposed to show it.
//
// The agreement case at the bottom is the one that matters. The pure predicate
// and the list() case would both still pass if someone re-forked the rule back
// into two implementations; only comparing the two surfaces catches that.
//
// The rule is a LISTING rule, not a jail — hiding is display-only. That is
// asserted here too, so nobody later mistakes it for an access boundary.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPO_MARKER_NAMES, isVisibleEntryName } from "./entry-visibility.js";
import { filesystemGate } from "./filesystem-gate.js";
import { channelMountGate } from "../channel-mounts/channel-mount-gate.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";

const TEST_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "crowdos-visibility-")));
const REPO = join(TEST_ROOT, "repo");
const TEST_REGISTRY = join(TEST_ROOT, "workspaces.json");
const TEST_LOCALSTORE = join(TEST_ROOT, "localstore");

const savedWorkspaceDir = process.env.WORKSPACE_DIR;

/** Every entry the fixtures create, so each surface is judged on the same set. */
const FIXTURE_ENTRIES = [
  "src",
  "README.md",
  ".ThisCrowd",
  ".crowdos",
  ".crowdosrc",
  ".git",
  ".env",
  ".editorconfig",
  ".DS_Store",
] as const;

function seedRepo(): void {
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, ".ThisCrowd"), { recursive: true });
  mkdirSync(join(REPO, ".crowdos"), { recursive: true });
  mkdirSync(join(REPO, ".git"), { recursive: true });
  writeFileSync(join(REPO, "README.md"), "# repo", "utf8");
  writeFileSync(join(REPO, ".crowdosrc"), "{}", "utf8");
  writeFileSync(join(REPO, ".env"), "SECRET=1", "utf8");
  writeFileSync(join(REPO, ".editorconfig"), "root = true", "utf8");
  writeFileSync(join(REPO, ".DS_Store"), "junk", "utf8");
}

/** The Repo tree side. */
async function treeNames(): Promise<string[]> {
  const fs = filesystemGate.createLocalFilesystem({
    workspaceId: "ws-visibility",
    workspaceRoot: REPO,
    actorId: "test-actor",
  });
  const nodes = await fs.list("/");
  return nodes.map((n) => n.name);
}

/** The mount picker side, through its gate. */
async function pickerNames(): Promise<string[]> {
  const res = await channelMountGate.browse(REPO);
  return res.entries.map((e) => e.name);
}

describe("entry visibility", () => {
  beforeEach(() => {
    // sandboxBase = TEST_ROOT puts the fixture repo inside the default mount
    // jail, so browse() serves REPO itself instead of clamping to a root.
    process.env.WORKSPACE_DIR = TEST_ROOT;
    setRegistryFilePathForTests(TEST_REGISTRY);
    setLocalStoreDirForTests(TEST_LOCALSTORE);
    rmSync(REPO, { recursive: true, force: true });
    seedRepo();
  });

  afterEach(() => {
    setRegistryFilePathForTests(null);
    setLocalStoreDirForTests(null);
    if (savedWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = savedWorkspaceDir;
  });

  describe("the rule", () => {
    it("keeps the three repo markers visible", () => {
      expect(REPO_MARKER_NAMES).toEqual([".ThisCrowd", ".crowdos", ".crowdosrc"]);
      for (const marker of REPO_MARKER_NAMES) {
        expect(isVisibleEntryName(marker)).toBe(true);
      }
    });

    it("hides every other dotfile, and shows everything without a leading dot", () => {
      for (const hidden of [".git", ".env", ".editorconfig", ".DS_Store", ".", ".."]) {
        expect(isVisibleEntryName(hidden)).toBe(false);
      }
      for (const shown of ["src", "README.md", "Makefile", "node_modules"]) {
        expect(isVisibleEntryName(shown)).toBe(true);
      }
    });

    it("is not a jail — hiding a name never makes it unreachable", async () => {
      // The rule decides what a LISTING shows. A caller that names a hidden path
      // still resolves it through its own path guard, so hiding must never be
      // read as an access boundary.
      const fs = filesystemGate.createLocalFilesystem({
        workspaceId: "ws-visibility",
        workspaceRoot: REPO,
        actorId: "test-actor",
      });
      await expect(fs.read("/.env")).resolves.toContain("SECRET=1");
      await expect(fs.read("/.editorconfig")).resolves.toContain("root = true");
      expect(await fs.exists("/.git")).toBe(true);
    });
  });

  describe("the tree (LocalFilesystem.list)", () => {
    it("hides ordinary dotfiles but lists the repo markers", async () => {
      const names = await treeNames();
      for (const marker of REPO_MARKER_NAMES) expect(names).toContain(marker);
      expect(names).not.toContain(".git");
      expect(names).not.toContain(".env");
      expect(names).not.toContain(".editorconfig");
      expect(names).not.toContain(".DS_Store");
    });

    it("lists exactly the visible subset of what is on disk", async () => {
      const names = await treeNames();
      const expected = FIXTURE_ENTRIES.filter((n) => isVisibleEntryName(n)).sort();
      expect([...names].sort()).toEqual([...expected]);
    });

    it("orders directories before files, then by name", async () => {
      const fs = filesystemGate.createLocalFilesystem({
        workspaceId: "ws-visibility",
        workspaceRoot: REPO,
        actorId: "test-actor",
      });
      const nodes = await fs.list("/");
      const types = nodes.map((n) => n.type);
      expect(types.lastIndexOf("directory")).toBeLessThan(types.indexOf("file"));
      const dirs = nodes.filter((n) => n.type === "directory").map((n) => n.name);
      expect([...dirs].sort((a, b) => a.localeCompare(b))).toEqual(dirs);
    });
  });

  describe("agreement", () => {
    it("the Repo tree and the mount picker list the same names for one directory", async () => {
      // The regression this file exists to prevent. Two surfaces, one directory,
      // one answer.
      const tree = (await treeNames()).sort();
      const picker = (await pickerNames()).sort();
      expect(tree).toEqual(picker);
      expect(tree.length).toBeGreaterThan(0);
    });

    it("both surfaces agree on the hidden set too", async () => {
      // Equal visible sets could still hide different things if one surface
      // dropped an entry for an unrelated reason. Pin the complement as well.
      const listed = new Set([...(await treeNames()), ...(await pickerNames())]);
      for (const name of [".git", ".env", ".editorconfig", ".DS_Store"]) {
        expect(listed.has(name)).toBe(false);
      }
    });
  });
});

