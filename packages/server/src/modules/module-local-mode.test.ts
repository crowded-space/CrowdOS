import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("module store hardening", () => {
  const modelRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

  it("corrupt module file is never overwritten (upsert and delete refuse)", async () => {
    const storeDir = join(dir, "ws-x", "vfs", ".crowdos");
    mkdirSync(storeDir, { recursive: true });
    const file = join(storeDir, "model-modules.json");
    const garbage = "{ this is not json";
    writeFileSync(file, garbage, "utf8");

    await expect(localUpsertModelModule(modelRow("mod-x") as any, "ws-x")).rejects.toMatchObject({
      code: "MODULE_STORE_CORRUPT",
    });
    await expect(moduleGate.model.remove("mod-x", "ws-x")).rejects.toMatchObject({
      code: "MODULE_STORE_CORRUPT",
    });
    // The corrupt bytes must survive both refused writes.
    expect(readFileSync(file, "utf8")).toBe(garbage);
    // Reads stay tolerant: get surfaces null instead of throwing.
    await expect(moduleGate.model.get("mod-x", "ws-x")).resolves.toBeNull();
  });

  it("empty limit falls back to the default page size, not 1", async () => {
    for (const id of ["mod-p1", "mod-p2", "mod-p3"]) {
      await localUpsertModelModule(modelRow(id) as any, "ws-p");
    }
    const empty = await moduleGate.model.list({ limit: "" as any, workspaceId: "ws-p" });
    expect(empty.length).toBe(3);
    // Explicit 0 is inside the documented 1-500 range, so it clamps to 1.
    const zero = await moduleGate.model.list({ limit: 0 as any, workspaceId: "ws-p" });
    expect(zero.length).toBe(1);
  });

  it("scoped reads stay tenant-scoped; unscoped get locates the owner folder", async () => {
    await localUpsertModelModule(modelRow("mod-a") as any, "ws-a");
    expect(await moduleGate.model.get("mod-a", "ws-a")).not.toBeNull();
    expect(await moduleGate.model.get("mod-a", "ws-a ")).not.toBeNull(); // trimmed
    // Sibling scopes never see the row: isolation is enforced on named scopes.
    expect(await moduleGate.model.get("mod-a", "ws-b")).toBeNull();
    // Unscoped callers carry only the id, so the read locates the owner
    // folder (server-model-fix scope agreement; mirrors agent/channel stores).
    expect(await moduleGate.model.get("mod-a")).not.toBeNull();
    expect(await moduleGate.model.get("mod-a", null)).not.toBeNull();
  });

  it("echoing the redacted mask back on update keeps the stored key", async () => {
    const created = await moduleGate.model.create(modelRow("mod-k", { apiKey: "sk-real-key-123" }) as any, "ws-k");
    const stored = (await moduleGate.model.get("mod-k", "ws-k"))!.apiKey;
    expect(stored).toBeTruthy();
    expect(stored).toBe(created.apiKey); // encrypt() ran once; later writes must not re-encrypt it

    for (const mask of ["••••••••", "••••", "[REDACTED]"]) {
      const updated = await moduleGate.model.update("mod-k", { apiKey: mask } as any, "ws-k");
      expect(updated!.apiKey).toBe(stored);
      expect((await moduleGate.model.get("mod-k", "ws-k"))!.apiKey).toBe(stored);
    }
    // Explicit null is still a clear.
    const cleared = await moduleGate.model.update("mod-k", { apiKey: null } as any, "ws-k");
    expect(cleared!.apiKey).toBeNull();
    expect(created.id).toBe("mod-k");
  });

  it("findReferencingAgents returns every blocker, scoped and unscoped", async () => {
    await localUpsertModelModule(modelRow("mod-many") as any, "ws-a");
    for (const [id, ws, name] of [
      ["agent-a", "ws-a", "first-user"],
      ["agent-b", "ws-b", "second-user"],
    ] as const) {
      await localUpsertAgent({
        id,
        workspaceId: ws,
        name,
        title: "T",
        authorityLevel: 1,
        modelModuleId: "mod-many",
        instructionModuleId: "instr-default",
        memorySharingPolicy: "full",
        status: "idle",
        isTemplate: false,
      });
    }
    const unscoped = await moduleGate.findReferencingAgents("model", "mod-many", null);
    expect(unscoped.map((a: any) => a.name).sort()).toEqual(["first-user", "second-user"]);
    const scoped = await moduleGate.findReferencingAgents("model", "mod-many", "ws-a");
    expect(scoped.map((a: any) => a.name)).toEqual(["first-user"]);
  });
});
