import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ENVELOPE_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PASSPHRASE_SALT = "crowdos.credentials.v1";

let warnedNoKeyWrite = false;
let warnedNoKeyRead = false;
let warnedPlaintextRead = false;

function loadKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  return scryptSync(raw, PASSPHRASE_SALT, KEY_BYTES);
}

let cachedKey: Buffer | null | undefined;
function getKey(): Buffer | null {
  if (cachedKey === undefined) cachedKey = loadKey();
  return cachedKey;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encrypt(secret: string): string {
  if (!secret || isEncrypted(secret)) return secret;
  const key = getKey();
  if (!key) {
    if (!warnedNoKeyWrite) {
      console.warn("[secretBox] CREDENTIALS_ENCRYPTION_KEY is not set; values will be stored unencrypted.");
      warnedNoKeyWrite = true;
    }
    return secret;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decrypt(value: string): string {
  if (!value) return value;
  const key = getKey();
  if (!isEncrypted(value)) {
    if (key && !warnedPlaintextRead) {
      console.warn("[secretBox] legacy plaintext value read without envelope; run db:encrypt-secrets to backfill.");
      warnedPlaintextRead = true;
    }
    return value;
  }
  if (!key) {
    if (!warnedNoKeyRead) {
      console.warn("[secretBox] CREDENTIALS_ENCRYPTION_KEY is not set; stored envelope returned as-is.");
      warnedNoKeyRead = true;
    }
    return value;
  }
  const parts = value.slice(ENVELOPE_PREFIX.length).split(":");
  const [ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("secretBox: malformed envelope");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("secretBox: decryption failed (wrong CREDENTIALS_ENCRYPTION_KEY or tampered data)");
  }
}

export function encryptRecordValues(
  record: Record<string, string> | null | undefined
): Record<string, string> | null | undefined {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v ? encrypt(v) : v]));
}

export function decryptRecordValues(
  record: Record<string, string> | null | undefined
): Record<string, string> | null | undefined {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v ? decrypt(v) : v]));
}

export const secretBox = { encrypt, decrypt, isEncrypted };
