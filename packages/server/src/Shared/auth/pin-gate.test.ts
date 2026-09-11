import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Hermetic: pin-gate reads workspace PINs from the local registry file —
// point it at a temp registry so no database (and no real registry) is touched.
vi.mock("../config/database.js", () => {
  return {
    getDb: () => {
      throw new Error("getDb is not available under the pin-gate registry test");
    },
    runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
    dbScopeKey: () => "global",
  };
});

import {
  getGlobalPin,
  hashScreenLockPin,
  verifyScreenLockPin,
  validateScreenLockPin,
  isScreenLockConfigured,
  matchesWorkspacePin,
  requirePin,
  verifyHandshakePin,
  invalidatePinCache,
} from "./pin-gate.js";
import {
  saveWorkspaceRecord,
  setRegistryFilePathForTests,
} from "../../workspace/workspace-registry.js";

// ponytail: the implementation reads PINs from workspaces.json (registry is
// the source of truth); seed there, not the legacy workspaces table.
async function seedRegistryPin(id: string, pin: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "crowdos-pingate-"));
  setRegistryFilePathForTests(join(dir, "workspaces.json"));
  const now = new Date().toISOString();
  await saveWorkspaceRecord({
    id,
    name: id,
    icon: "x",
    databaseUrl: "",
    rootPath: join(dir, id),
    screenLockPinHash: hashScreenLockPin(pin),
    createdAt: now,
    updatedAt: now,
  });
}

let savedLocalPin: string | undefined;

beforeEach(() => {
  savedLocalPin = process.env.LOCAL_PIN;
  delete process.env.LOCAL_PIN;
});

afterEach(async () => {
  if (savedLocalPin === undefined) delete process.env.LOCAL_PIN;
  else process.env.LOCAL_PIN = savedLocalPin;
  setRegistryFilePathForTests(null);
  invalidatePinCache();
  vi.restoreAllMocks();
});

function httpCtx(opts: { method?: string; url?: string; headers?: Record<string, string> } = {}) {
  const sent: Array<{ status: number; body: unknown }> = [];
  const request = {
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/workspaces",
    headers: opts.headers ?? {},
  } as any;
  const reply = {
    status: (code: number) => ({
      send: (body: unknown) => {
        sent.push({ status: code, body });
      },
    }),
  } as any;
  return { request, reply, sent };
}

describe("pin-gate · no hardcoded fallback (explicit opt-in screenlock)", () => {
  it("getGlobalPin returns null when LOCAL_PIN is unset/blank (no '123456' default)", () => {
    delete process.env.LOCAL_PIN;
    expect(getGlobalPin()).toBeNull();
    process.env.LOCAL_PIN = "   ";
    expect(getGlobalPin()).toBeNull();
    process.env.LOCAL_PIN = " 9999 ";
    expect(getGlobalPin()).toBe("9999");
  });

  it("disabled state: requirePin allows when nothing is configured anywhere", async () => {
    const { request, reply, sent } = httpCtx();
    await requirePin(request, reply);
    expect(sent).toHaveLength(0);
    expect(request.userId).toBe("local-user");
  });

  it("disabled state: handshake allows when nothing is configured anywhere", async () => {
    await expect(verifyHandshakePin(undefined, {})).resolves.toBe(true);
    await expect(verifyHandshakePin({ pin: "anything" }, {})).resolves.toBe(true);
  });

  it("global PIN: correct PIN passes, wrong PIN is rejected", async () => {
    process.env.LOCAL_PIN = "s3cret-workspace";
    const ok = httpCtx({ headers: { "x-pin": "s3cret-workspace" } });
    await requirePin(ok.request, ok.reply);
    expect(ok.sent).toHaveLength(0);

    const bad = httpCtx({ headers: { "x-pin": "123456" } });
    await requirePin(bad.request, bad.reply);
    expect(bad.sent).toHaveLength(1);
    expect(bad.sent[0].status).toBe(401);

    // The old hardcoded default must NOT be accepted.
    const legacy = httpCtx({ headers: { "x-pin": "123456" } });
    await requirePin(legacy.request, legacy.reply);
    expect(legacy.sent).toHaveLength(1);
  });

  it("global PIN: handshake accepts Bearer and rejects unknown", async () => {
    process.env.LOCAL_PIN = "s3cret-workspace";
    await expect(
      verifyHandshakePin(undefined, { authorization: "Bearer s3cret-workspace" }),
    ).resolves.toBe(true);
    await expect(verifyHandshakePin({ pin: "nope" }, {})).resolves.toBe(false);
    await expect(verifyHandshakePin(undefined, {})).resolves.toBe(false);
  });

  it("workspace PIN: accepted for HTTP + handshake when no global PIN is set", async () => {
    await seedRegistryPin("ws_1", "workspace-pin-1");
    await expect(isScreenLockConfigured()).resolves.toBe(true);
    await expect(matchesWorkspacePin("workspace-pin-1")).resolves.toBe(true);
    await expect(matchesWorkspacePin("wrong")).resolves.toBe(false);

    const ok = httpCtx({ headers: { "x-pin": "workspace-pin-1" } });
    await requirePin(ok.request, ok.reply);
    expect(ok.sent).toHaveLength(0);

    const bad = httpCtx({ headers: { "x-pin": "wrong" } });
    await requirePin(bad.request, bad.reply);
    expect(bad.sent).toHaveLength(1);

    await expect(verifyHandshakePin({ pin: "workspace-pin-1" }, {})).resolves.toBe(true);
    await expect(verifyHandshakePin({ pin: "wrong" }, {})).resolves.toBe(false);
  });

  it("precedence: global and workspace PINs are each accepted", async () => {
    process.env.LOCAL_PIN = "global-pin";
    await seedRegistryPin("ws_1", "workspace-pin-1");
    await expect(verifyHandshakePin({ pin: "global-pin" }, {})).resolves.toBe(true);
    await expect(verifyHandshakePin({ pin: "workspace-pin-1" }, {})).resolves.toBe(true);
    await expect(verifyHandshakePin({ pin: "neither" }, {})).resolves.toBe(false);
  });

  it("health paths stay exempt even when a PIN is configured", async () => {
    process.env.LOCAL_PIN = "global-pin";
    for (const url of ["/health", "/api/health"]) {
      const { request, reply, sent } = httpCtx({ url });
      await requirePin(request, reply);
      expect(sent).toHaveLength(0);
    }
  });
});

describe("pin-gate · hashing (never plaintext)", () => {
  it("round-trips, salts uniquely, and rejects wrong/malformed input", () => {
    const a = hashScreenLockPin("my-workspace-pin");
    const b = hashScreenLockPin("my-workspace-pin");
    expect(a).not.toBe(b);
    expect(a).not.toContain("my-workspace-pin");
    expect(verifyScreenLockPin("my-workspace-pin", a)).toBe(true);
    expect(verifyScreenLockPin(" my-workspace-pin ", a)).toBe(true);
    expect(verifyScreenLockPin("other", a)).toBe(false);
    expect(verifyScreenLockPin("my-workspace-pin", null)).toBe(false);
    expect(verifyScreenLockPin("my-workspace-pin", "garbage")).toBe(false);
    expect(verifyScreenLockPin("my-workspace-pin", "scrypt$zz$zz")).toBe(false);
  });

  it("validateScreenLockPin enforces 4..128 chars", () => {
    expect(validateScreenLockPin("  1234  ")).toBe("1234");
    expect(() => validateScreenLockPin("123")).toThrow(/at least 4/);
    expect(() => validateScreenLockPin("")).toThrow();
    expect(() => validateScreenLockPin("   ")).toThrow();
    expect(() => validateScreenLockPin("x".repeat(129))).toThrow(/at most/);
    expect(() => validateScreenLockPin(123 as any)).toThrow();
  });
});
