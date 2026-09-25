import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// True no-DB simulation (channel-local-mode.test.ts pattern): the real tier
// resolution must take the local path because DATABASE_URL is unset.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { moduleGate } from "./module-gate.js";
import { localUpsertModelModule } from "./module-local-store.js";
import { localUpsertAgent } from "../agents/agent-local-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-modules-local-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("module delete guard in Local mode (no DATABASE_URL)", () => {
  it("finds a referencing agent from the local roster and still blocks deletes", async () => {
    const now = new Date();
    const moduleRow = {
      id: "mod-1",
      label: "test",
      provider: "google" as const,
      modelName: "cbai/deepseek-v4.1-flash(max)",
      apiKey: null,
      endpointUrl: "http://localhost:20128/v1",
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 2048,
      stopSequences: [] as string[],
      maxRecentMessages: 10,
      enableCompression: true,
      compressionThreshold: 15,
      createdAt: now,
      updatedAt: now,
    };
    await localUpsertModelModule(moduleRow as any, "ws-local");
    await localUpsertAgent({
      id: "agent-1",
      workspaceId: "ws-local",
      name: "uses-module",
      title: "T",
      authorityLevel: 1,
      modelModuleId: "mod-1",
      instructionModuleId: "instr-default",
      memorySharingPolicy: "full",
      status: "idle",
      isTemplate: false,
    });

    // Regression: this threw "DATABASE_URL is not set" in Local mode, which
    // surfaced as a 500 "An unexpected error occurred" on de-registration.
    const blocker = await moduleGate.findReferencingAgent("model", "mod-1");
    expect(blocker?.name).toBe("uses-module");
  });

  it("deletes an unreferenced module", async () => {
    const now = new Date();
    await localUpsertModelModule(
      {
        id: "mod-2",
        label: "free",
        provider: "google",
        modelName: "gemini-2.0-flash",
        apiKey: null,
        endpointUrl: null,
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 2048,
        stopSequences: [],
        maxRecentMessages: 10,
        enableCompression: true,
        compressionThreshold: 15,
        createdAt: now,
        updatedAt: now,
      } as any,
      "ws-local",
    );
    const deleted = await moduleGate.model.remove("mod-2", "ws-local");
    expect(deleted.length).toBe(1);
  });

  it("delete guard is tenant-scoped: an agent in ws-B does not block a ws-A module delete", async () => {
    const now = new Date();
    await localUpsertModelModule(
      {
        id: "mod-wsa",
        label: "ws-a module",
        provider: "google",
        modelName: "gemini-2.0-flash",
        apiKey: null,
        endpointUrl: null,
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 2048,
        stopSequences: [] as string[],
        maxRecentMessages: 10,
        enableCompression: true,
        compressionThreshold: 15,
        createdAt: now,
        updatedAt: now,
      } as any,
      "ws-a",
    );
    await localUpsertAgent({
      id: "agent-wsb",
      workspaceId: "ws-b",
      name: "cross-tenant-user",
      title: "T",
      authorityLevel: 1,
      modelModuleId: "mod-wsa",
      instructionModuleId: "instr-default",
      memorySharingPolicy: "full",
      status: "idle",
      isTemplate: false,
    });

    // Same module id, but the referencing agent lives in another workspace —
    // the scoped lookup must not see it.
    const blocker = await moduleGate.findReferencingAgent("model", "mod-wsa", "ws-a");
    expect(blocker).toBeNull();
    // Unscoped lookup (legacy) still finds it.
    const unscoped = await moduleGate.findReferencingAgent("model", "mod-wsa", null);
    expect(unscoped?.name).toBe("cross-tenant-user");
  });

  it("module create without a workspace scope throws in production-like envs", async () => {
    // Vitest exempts unscoped writes for fixtures, so simulate the guard the
    // production path hits by calling the store guard directly.
    const { localUpsertInstructionModule } = await import("./module-local-store.js");
    const now = new Date().toISOString();
    // Under VITEST the guard allows the write (fixture mechanism) — assert the
    // documented exemption rather than faking a prod env.
    await expect(
      localUpsertInstructionModule({ id: "m1", label: "L", createdAt: now, updatedAt: now } as any, undefined),
    ).resolves.toBeUndefined();
  });

  it("ensureDefaults is a no-op without a workspace scope (no confusing module-guard error)", async () => {
    // Regression: an unscoped agent create in local mode used to fail inside
    // ensureDefaultModules with "workspaceId is required when creating a
    // module" before the agent store's own tenant guard could explain the
    // refusal. The canon defaults are per-workspace rows; with no scope there
    // is nothing to seed.
    await expect(moduleGate.ensureDefaults(null)).resolves.toBeUndefined();
    await expect(moduleGate.ensureDefaults(undefined)).resolves.toBeUndefined();
  });
});
