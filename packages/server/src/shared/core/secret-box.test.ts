import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SecretBoxModule = typeof import("./secret-box.js");

const HEX_KEY = "a".repeat(64);
const B64_KEY = Buffer.alloc(32, 7).toString("base64");
const PASSPHRASE = "correct horse battery staple";

async function loadBox(): Promise<SecretBoxModule> {
  vi.resetModules();
  return import("./secret-box.js");
}

beforeEach(() => {
  delete process.env.CREDENTIALS_ENCRYPTION_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SEC-4 · secretBox envelope encryption", () => {
  it("roundtrips a secret through AES-256-GCM with the enc:v1 envelope", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const { encrypt, decrypt, isEncrypted } = await loadBox();

    const plain = "sk-test-1234567890abcdef";
    const sealed = encrypt(plain);

    expect(sealed).not.toBe(plain);
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed.split(":")).toHaveLength(5);
    expect(decrypt(sealed)).toBe(plain);
    expect(isEncrypted(plain)).toBe(false);
  });

  it("throws on tampered ciphertext (GCM auth tag mismatch)", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const { encrypt, decrypt } = await loadBox();

    const sealed = encrypt("tamper-target");
    const [, , ivB64, tagB64, ctB64] = sealed.split(":");
    const ct = Buffer.from(ctB64, "base64");
    ct[0] ^= 0xff;
    const tampered = `enc:v1:${ivB64}:${tagB64}:${ct.toString("base64")}`;

    expect(() => decrypt(tampered)).toThrow(/decryption failed/);
  });

  it("throws when decrypting with a different key", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const first = await loadBox();
    const sealed = first.encrypt("cross-key-secret");

    process.env.CREDENTIALS_ENCRYPTION_KEY = "b".repeat(64);
    const second = await loadBox();
    expect(() => second.decrypt(sealed)).toThrow(/decryption failed/);
  });

  it("passes plaintext through unchanged in disabled mode and warns once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { encrypt, decrypt } = await loadBox();

    expect(process.env.CREDENTIALS_ENCRYPTION_KEY).toBeUndefined();
    expect(encrypt("sk-disabled-mode")).toBe("sk-disabled-mode");
    expect(encrypt("sk-disabled-mode")).toBe("sk-disabled-mode");
    expect(decrypt("sk-disabled-mode")).toBe("sk-disabled-mode");

    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const keyWarnings = warns.filter((w) => w.includes("[secretBox]"));
    expect(keyWarnings).toHaveLength(1);
  });

  it("returns stored envelopes as-is in disabled mode instead of crashing", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const sealedWriter = await loadBox();
    const sealed = sealedWriter.encrypt("locked-value");

    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    const disabledReader = await loadBox();
    expect(disabledReader.decrypt(sealed)).toBe(sealed);
  });

  it("falls back to plaintext values during the migration window", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decrypt } = await loadBox();

    expect(decrypt("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("backfill"))).toBe(true);
  });

  it("derives a stable key from a passphrase across fresh module loads", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = PASSPHRASE;
    const writer = await loadBox();
    const sealedA = writer.encrypt("passphrase-stability");
    const sealedB = writer.encrypt("passphrase-stability");

    expect(sealedA).not.toBe(sealedB);
    const reader = await loadBox();
    expect(reader.decrypt(sealedA)).toBe("passphrase-stability");
    expect(reader.decrypt(sealedB)).toBe("passphrase-stability");
  });

  it("accepts a 32-byte base64 key equivalently for roundtrip", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = B64_KEY;
    const { encrypt, decrypt } = await loadBox();
    const sealed = encrypt("b64-key-secret");
    expect(decrypt(sealed)).toBe("b64-key-secret");
  });

  it("encrypts and decrypts each value of an env-var map idempotently", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    const box = await loadBox();

    const original = { API_TOKEN: "tok_123", DEBUG: "" };
    const sealedMap = box.encryptRecordValues(original);

    expect(sealedMap!.DEBUG).toBe("");
    expect(box.isEncrypted(sealedMap!.API_TOKEN)).toBe(true);

    const doubleSealed = box.encryptRecordValues(sealedMap!);
    expect(doubleSealed).toEqual(sealedMap);

    expect(box.decryptRecordValues(sealedMap)).toEqual(original);
    expect(box.decryptRecordValues(undefined)).toBeUndefined();
    expect(box.decryptRecordValues(null)).toBeNull();
  });
});
