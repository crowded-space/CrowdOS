import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { and, eq, isNull } from "drizzle-orm";

import { getDb, resolveTier } from "../config/database.js";
import { mutateJsonArray, readJsonArray } from "../core/local-file.js";
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

interface LocalKeyRow {
  id: string;
  keyHash: string;
  label: string | null;
  role: ApiKeyRole;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const API_KEYS_FILE = "api-keys.json";

/**
 * Dual-boot key lookup: union PG rows + local file rows (either side may be
 * down). A key revoked in EITHER tier counts as revoked. Local file rows let
 * a DB-less boot stay strictly authenticated instead of failing open.
 */
async function findActiveKeys(): Promise<(ApiKeyRecord & { keyHash: string })[]> {
  const [pgRows, localRows] = await Promise.all([
    (async () => {
      try {
        const db = getDb();
        return await db
          .select({
            id: apiKeys.id,
            label: apiKeys.label,
            role: apiKeys.role,
            keyHash: apiKeys.keyHash,
          })
          .from(apiKeys)
          .where(isNull(apiKeys.revokedAt));
      } catch {
        return [];
      }
    })(),
    readJsonArray<LocalKeyRow>(API_KEYS_FILE).catch(() => [] as LocalKeyRow[]),
  ]);
  const revokedIds = new Set<string>();
  for (const r of [...pgRows, ...localRows]) {
    const revoked = (r as any).revokedAt;
    if (revoked) revokedIds.add(r.id);
  }
  const byId = new Map<string, ApiKeyRecord & { keyHash: string }>();
  for (const r of [...pgRows, ...localRows]) {
    if (revokedIds.has(r.id) || byId.has(r.id)) continue;
    byId.set(r.id, { id: r.id, label: r.label ?? null, role: r.role, keyHash: (r as any).keyHash });
  }
  return [...byId.values()];
}

async function touchLocalKey(id: string): Promise<void> {
  await mutateJsonArray<LocalKeyRow>(API_KEYS_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows[idx] = { ...rows[idx], lastUsedAt: new Date().toISOString() };
  }).catch(() => {});
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
    try {
      await getDb()
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, matched.id));
    } catch {
      // PG down or row lives locally — best-effort only.
    }
    await touchLocalKey(matched.id);
  }

  return matched;
}

export async function createApiKey(input?: {
  label?: string;
  role?: ApiKeyRole;
}): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const keyHash = await hashApiKey(key);
  const now = new Date().toISOString();
  // Dual-boot: PG when reachable, local file always (single-tier fallback —
  // keys are auth infrastructure, not backfilled content).
  const { tier } = resolveTier({});
  if (tier === "dual") {
    try {
      const db = getDb();
      const [row] = await db
        .insert(apiKeys)
        .values({
          keyHash,
          label: input?.label ?? null,
          role: input?.role ?? "viewer",
        })
        .returning({ id: apiKeys.id, label: apiKeys.label, role: apiKeys.role });
      return { key, record: row };
    } catch (err) {
      const { isConnectionError } = await import("../config/database.js");
      if (!isConnectionError(err)) throw err;
    }
  }
  const id = randomUUID();
  const localRow: LocalKeyRow = {
    id,
    keyHash,
    label: input?.label ?? null,
    role: input?.role ?? "viewer",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
  };
  await mutateJsonArray<LocalKeyRow>(API_KEYS_FILE, (rows) => {
    rows.push(localRow);
  });
  return { key, record: { id, label: localRow.label, role: localRow.role } };
}

export async function revokeKey(keyId: string): Promise<boolean> {
  // Revoke in both tiers (either may hold the row); true when either flipped.
  let revoked = false;
  try {
    const db = getDb();
    const rows = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    revoked = rows.length > 0;
  } catch {
    // PG down — local revoke below still applies.
  }
  await mutateJsonArray<LocalKeyRow>(API_KEYS_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === keyId && !r.revokedAt);
    if (idx !== -1) {
      rows[idx] = { ...rows[idx], revokedAt: new Date().toISOString() };
      revoked = true;
    }
  }).catch(() => {});
  return revoked;
}

/**
 * SEC-1 bootstrap: guarantee at least one non-revoked admin key exists.
 * The plaintext key is emitted exactly once, to stdout, in a delimited
 * block. It is never logged again and never persisted.
 */
export async function seedBootstrapAdminKey(): Promise<{ key: string } | null> {
  const existingAdmins = (await findActiveKeys().catch(() => []))
    .filter((k) => k.role === "admin");

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
