// DB-001 regression: `--apply` without CREDENTIALS_ENCRYPTION_KEY must fail
// fast (skipped-no-key, exit 1) instead of reporting "Encrypted N row(s)"
// while encrypt() silently returns the input unchanged.
//
// secret-box caches the derived key per module instance, so each case
// re-imports the module graph after vi.resetModules().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY_HEX = "ab".repeat(32);

async function load() {
  vi.resetModules();
  const backfill = await import("./backfill-encrypt-secrets.js");
  const secretBox = await import("../shared/core/secret-box.js");
  return { backfill, secretBox };
}

describe("DB-001 · backfill-encrypt-secrets key gate", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = savedKey;
  });

  it("hasEncryptionKey: false when unset/blank, true when configured", async () => {
    const { backfill } = await load();
    expect(backfill.hasEncryptionKey({})).toBe(false);
    expect(backfill.hasEncryptionKey({ CREDENTIALS_ENCRYPTION_KEY: "   " })).toBe(false);
    expect(backfill.hasEncryptionKey({ CREDENTIALS_ENCRYPTION_KEY: KEY_HEX })).toBe(true);
  });

  it("apply without key: 0 encrypted, nothing persisted", async () => {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    const { backfill } = await load();
    const persisted: string[] = [];
    const stat = await backfill.backfillApiKeyColumn(
      "model_modules",
      [{ id: "row-1", apiKey: "sk-plaintext" }],
      async (id, sealed) => { persisted.push(`${id}:${sealed}`); },
      true
    );
    expect(stat.plaintextFound).toBe(1);
    expect(stat.encryptedNow).toBe(0);
    expect(persisted).toEqual([]);
  });

  it("apply with key: envelope written and counted", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_HEX;
    const { backfill, secretBox } = await load();
    const persisted: string[] = [];
    const stat = await backfill.backfillApiKeyColumn(
      "model_modules",
      [
        { id: "row-1", apiKey: "sk-plaintext" },
        { id: "row-2", apiKey: null },
      ],
      async (id, sealed) => { persisted.push(`${id}:${sealed}`); },
      true
    );
    expect(stat.plaintextFound).toBe(1);
    expect(stat.encryptedNow).toBe(1);
    expect(persisted).toHaveLength(1);
    const sealed = persisted[0].slice(persisted[0].indexOf(":") + 1);
    expect(secretBox.isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain("sk-plaintext");
  });

  it("dry-run never persists and never counts", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_HEX;
    const { backfill } = await load();
    const persisted: string[] = [];
    const stat = await backfill.backfillApiKeyColumn(
      "model_modules",
      [{ id: "row-1", apiKey: "sk-plaintext" }],
      async (id, sealed) => { persisted.push(`${id}:${sealed}`); },
      false
    );
    expect(stat.plaintextFound).toBe(1);
    expect(stat.encryptedNow).toBe(0);
    expect(persisted).toEqual([]);
  });

  it("already-encrypted rows stay untouched", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_HEX;
    const { backfill } = await load();
    const persist = async () => { throw new Error("must not persist"); };
    const stat = await backfill.backfillApiKeyColumn(
      "model_modules",
      [{ id: "row-1", apiKey: "enc:v1:aXY=:dGFn:Y3Q=" }],
      persist,
      true
    );
    expect(stat.alreadyEncrypted).toBe(1);
    expect(stat.encryptedNow).toBe(0);
  });
});
