import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

import { channelMountGate } from "./channel-mount-gate.js";
import { channelMountRoutes } from "../routes/channel-mounts.js";
import { validatorCompiler } from "../shared/core/validation.js";

describe("channelMountGate & Native OS Mounts", () => {
  const prevAllowed = process.env.ALLOWED_MOUNT_ROOTS;
  beforeEach(() => {
    process.env.ALLOWED_MOUNT_ROOTS = process.cwd();
  });
  afterAll(() => {
    if (prevAllowed !== undefined) {
      process.env.ALLOWED_MOUNT_ROOTS = prevAllowed;
    } else {
      delete process.env.ALLOWED_MOUNT_ROOTS;
    }
  });
  it("allowedRoots returns accessible roots including cwd and homedir", () => {
    const roots = channelMountGate.allowedRoots();
    expect(Array.isArray(roots)).toBe(true);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.some((r) => r.toLowerCase() === path.resolve(process.cwd()).toLowerCase())).toBe(true);
  });

  describe("validate", () => {
    it("validates an existing directory", async () => {
      const res = await channelMountGate.validate(process.cwd());
      expect(res.valid).toBe(true);
      expect(res.resolved).toBeDefined();
    });

    it("rejects empty path", async () => {
      const res = await channelMountGate.validate("");
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Path required");
    });

    it("rejects non-existent directory", async () => {
      const nonExistent = path.join(process.cwd(), "non_existent_folder_xyz_999");
      const res = await channelMountGate.validate(nonExistent);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Path does not exist");
    });

    it("rejects a file as mount path", async () => {
      const packageJson = path.join(process.cwd(), "package.json");
      if (fs.existsSync(packageJson)) {
        const res = await channelMountGate.validate(packageJson);
        expect(res.valid).toBe(false);
        expect(res.error).toBe("Path is not a directory");
      }
    });
  });

  describe("browse", () => {
    it("browses current directory and returns filtered entries with paths", async () => {
      const res = await channelMountGate.browse(process.cwd());
      expect(res.path).toBeDefined();
      expect(Array.isArray(res.entries)).toBe(true);
      expect(Array.isArray(res.allowedRoots)).toBe(true);
      // Ensure hidden files except .ThisCrowd/.crowdos are excluded
      expect(res.entries.some((e) => e.name.startsWith(".") && e.name !== ".ThisCrowd" && e.name !== ".crowdos")).toBe(false);
      // Ensure entries include path
      if (res.entries.length > 0) {
        expect(res.entries[0].path).toBeDefined();
      }
    });
  });

  describe("pickNative", () => {
    it("handles pickNative gracefully with initialPath option", async () => {
      const pickSpy = vi.spyOn(channelMountGate, "pickNative").mockResolvedValue({ path: process.cwd(), canceled: false });
      const res = await channelMountGate.pickNative({ initialPath: process.cwd() });
      expect(res.canceled).toBe(false);
      expect(res.path).toBe(process.cwd());
      pickSpy.mockRestore();
    });
  });

  describe("Workspace mount functions", () => {
    it("resolveWorkspace returns none when workspace not found", async () => {
      const res = await channelMountGate.resolveWorkspace("non-existent-workspace-id");
      expect(res.source).toBe("none");
      expect(res.mountedPath).toBeNull();
    });

    it("attaches workspace mount and inherits down to channel", async () => {
      const { __socketTestDb } = await import("../shared/config/database.js") as any;
      if (__socketTestDb) {
        __socketTestDb.reset();
        __socketTestDb.store.workspaces.push({
          id: "ws-test-1",
          name: "Test Workspace",
          rootPath: process.cwd(),
          metadata: { customMountPath: process.cwd() },
        });
        __socketTestDb.store.channels.push({
          id: "ch-test-1",
          workspaceId: "ws-test-1",
          name: "general",
          folderPath: null,
          categoryId: null,
        });

        // Resolve workspace mount
        const wsMount = await channelMountGate.resolveWorkspace("ws-test-1");
        expect(wsMount.source).toBe("workspace");
        expect(wsMount.mountedPath).toBe((await channelMountGate.validate(process.cwd())).resolved);

        // Channel should inherit workspace mount
        const chMount = await channelMountGate.resolve("ch-test-1");
        expect(chMount.source).toBe("workspace");
        expect(chMount.mountedPath).toBe(wsMount.mountedPath);
      }
    });
  });

  describe("Fastify route integration", () => {
    async function buildApp() {
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      await channelMountRoutes(app);
      await app.ready();
      return app;
    }

    it("GET /api/fs/allowed-roots returns list of allowed roots", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/fs/allowed-roots" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.roots)).toBe(true);
      expect(data.roots.length).toBeGreaterThan(0);
    });

    it("GET /api/fs/browse returns directory listing and allowed roots", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/fs/browse?path=${encodeURIComponent(process.cwd())}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.path).toBeDefined();
      expect(Array.isArray(data.entries)).toBe(true);
      expect(Array.isArray(data.allowedRoots)).toBe(true);
    });

    it("POST /api/fs/pick-folder returns 410 Gone (deprecated, use desktop dialog)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/fs/pick-folder",
        payload: { initialPath: process.cwd() },
      });
      expect(res.statusCode).toBe(410);
      const data = res.json();
      expect(data.error).toBe("Gone");
    });

    it("GET /api/workspaces/:id/mount resolves workspace mount", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/workspaces/ws-test-1/mount",
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.source).toBeDefined();
    });
  });
});
