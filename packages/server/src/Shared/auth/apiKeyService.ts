import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../config/database.js";
import { apiKeys } from "../../db/schema.js";
import type { ApiKeyRole } from "../../db/schema.js";

export type { ApiKeyRole };

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;
export const API_KEY_PREFIX = "crowd_";

export interface ApiKeyRecord {
  id: string;
  label: string | null;
  role: ApiKeyRole;
}

export async function hashApiKey(key: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(key, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyHashMatch(key: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  const derived = await scrypt(key, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

async function findActiveKeys(): Promise<(ApiKeyRecord & { keyHash: string })[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      role: apiKeys.role,
      keyHash: apiKeys.keyHash,
    })
    .from(apiKeys)
    .where(isNull(apiKeys.revokedAt));
  return rows;
}

/**
 * Verify a presented plaintext key against active (non-revoked) keys.
 * Scrypt uses a per-key random salt, so candidates are compared with
 * timingSafeEqual rather than an equality lookup. last_used_at is touched
 * fire-and-forget on success.
 */
export async function verifyKey(key: string): Promise<ApiKeyRecord | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;

  let matched: ApiKeyRecord | null = null;
  for (const row of await findActiveKeys()) {
    if (await verifyHashMatch(key, row.keyHash)) {
      matched = { id: row.id, label: row.label, role: row.role };
      break;
    }
  }

  if (matched) {
    void getDb()
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, matched.id))
      .catch(() => {});
  }

  return matched;
}

export async function createApiKey(input?: {
  label?: string;
  role?: ApiKeyRole;
}): Promise<{ key: string; record: ApiKeyRecord }> {
  const db = getDb();
  const key = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      keyHash: await hashApiKey(key),
      label: input?.label ?? null,
      role: input?.role ?? "viewer",
    })
    .returning({ id: apiKeys.id, label: apiKeys.label, role: apiKeys.role });
  return { key, record: row };
}

export async function revokeKey(keyId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * SEC-1 bootstrap: guarantee at least one non-revoked admin key exists.
 * The plaintext key is emitted exactly once, to stdout, in a delimited
 * block. It is never logged again and never persisted.
 */
export async function seedBootstrapAdminKey(): Promise<{ key: string } | null> {
  const db = getDb();
  const existingAdmins = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.role, "admin"), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (existingAdmins.length > 0) return null;

  const { key, record } = await createApiKey({ label: "bootstrap-admin", role: "admin" });

  console.log("=======================================================");
  console.log(" BOOTSTRAP ADMIN API KEY (shown ONCE — store it now)");
  console.log(` key id : ${record.id}`);
  console.log(` label  : ${record.label}`);
  console.log(` role   : ${record.role}`);
  console.log(` key    : ${key}`);
  console.log("=======================================================");

  return { key };
}
