import type { FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "../config/database.js";
import { workspaces } from "../../db/schema.js";
import { TtlCache } from "../core/ttl-cache.js";

// ─── Local screenlock PIN ────────────────────────────────────────────
// Surface-level screenlock against casual physical access — NOT full auth.
// Explicit opt-in: when no PIN is configured anywhere, the gate is DISABLED
// (all requests pass) instead of falling back to an insecure default.
//
// Precedence:
//   1. Global `LOCAL_PIN` env var, when set to a non-empty value (operator override).
//   2. Per-workspace screenlock PIN (scrypt hash stored in `workspaces.json`
//      registry & optionally `workspaces.screen_lock_pin_hash`, managed via Workspace settings).
//   3. Neither configured → disabled → allow.

const HASH_PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

export const SCREEN_LOCK_PIN_MIN_LENGTH = 4;
export const SCREEN_LOCK_PIN_MAX_LENGTH = 128;

type WorkspacePinResolver = (workspaceId: string) => Promise<string | null>;
let workspacePinResolver: WorkspacePinResolver | null = null;

export function setWorkspacePinResolver(resolver: WorkspacePinResolver | null): void {
  workspacePinResolver = resolver;
}

/** Global env PIN, or null when unset/empty (= not configured, opt-in). */
export function getGlobalPin(): string | null {
  const raw = process.env.LOCAL_PIN;
  if (raw == null || raw.trim() === "") return null;
  return raw.trim();
}

/** Validate + normalize a candidate screenlock PIN. Returns trimmed PIN or throws. */
export function validateScreenLockPin(pin: unknown): string {
  if (typeof pin !== "string") throw new Error("Screenlock PIN must be a string.");
  const trimmed = pin.trim();
  if (trimmed.length < SCREEN_LOCK_PIN_MIN_LENGTH) {
    throw new Error(`Screenlock PIN must be at least ${SCREEN_LOCK_PIN_MIN_LENGTH} characters.`);
  }
  if (trimmed.length > SCREEN_LOCK_PIN_MAX_LENGTH) {
    throw new Error(`Screenlock PIN must be at most ${SCREEN_LOCK_PIN_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

/** Hash a validated PIN for storage. Plaintext is never persisted. */
export function hashScreenLockPin(pin: string): string {
  const normalized = validateScreenLockPin(pin);
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(normalized, salt, KEY_BYTES, SCRYPT_OPTS);
  return `${HASH_PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Timing-safe comparison of a candidate PIN against a stored hash. Never throws. */
export function verifyScreenLockPin(pin: string, hash: string | null | undefined): boolean {
  try {
    if (typeof pin !== "string" || typeof hash !== "string" || !hash) return false;
    const parts = hash.split("$");
    if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
    const candidate = scryptSync(pin.trim(), salt, KEY_BYTES, SCRYPT_OPTS);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

const scryptAsync = (pin: string, salt: Buffer, keyLen: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(pin, salt, keyLen, SCRYPT_OPTS, (err, key) => (err ? reject(err) : resolve(key as Buffer))),
  );

/** Async variant for the per-request verify path (never blocks the event loop). */
async function verifyScreenLockPinAsync(pin: string, hash: string | null | undefined): Promise<boolean> {
  try {
    if (typeof pin !== "string" || typeof hash !== "string" || !hash) return false;
    const parts = hash.split("$");
    if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
    const candidate = await scryptAsync(pin.trim(), salt, KEY_BYTES);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

interface WorkspacePinEntry {
  id: string;
  hash: string | null;
}

/** Load (id, hash) pairs for workspaces. Empty array when DB is unavailable. */
async function loadWorkspacePinEntries(): Promise<WorkspacePinEntry[]> {
  try {
    // Facade rule: route through the Workspace gate, never the registry
    // internals (dynamic import keeps the Shared->Workspace edge lazy).
    const { listWorkspaceRecords } = await import("../../workspace/workspace-gate.js");
    const records = await listWorkspaceRecords();
    return records.map((r) => ({ id: r.id, hash: r.screenLockPinHash ?? null }));
  } catch {
    return [];
  }
}

const pinEntriesCache = new TtlCache<WorkspacePinEntry[]>(15_000, 1);
const PIN_ENTRIES_CACHE_KEY = "workspace-pin-entries";

async function loadWorkspacePinEntriesCached(): Promise<WorkspacePinEntry[]> {
  const hit = pinEntriesCache.get(PIN_ENTRIES_CACHE_KEY);
  if (hit) return hit;
  const entries = await loadWorkspacePinEntries();
  pinEntriesCache.set(PIN_ENTRIES_CACHE_KEY, entries);
  return entries;
}

/** Drop the cached workspace PIN entries (screen-lock writes, tests). */
export function invalidatePinCache(): void {
  pinEntriesCache.delete(PIN_ENTRIES_CACHE_KEY);
}

/** True when any screenlock is configured (global env OR any workspace hash). */
export async function isScreenLockConfigured(): Promise<boolean> {
  if (getGlobalPin() !== null) return true;
  const entries = await loadWorkspacePinEntriesCached();
  return entries.some((e) => typeof e.hash === "string" && e.hash.length > 0);
}

/** True when the candidate matches any workspace-configured screenlock PIN. */
export async function matchesWorkspacePin(pin: string): Promise<boolean> {
  if (!pin) return false;
  const entries = await loadWorkspacePinEntriesCached();
  const results = await Promise.all(entries.map((e) => verifyScreenLockPinAsync(pin, e.hash)));
  return results.some(Boolean);
}

/** Paths exempt from PIN + rate limiting (liveness/readiness probes). Single source of truth. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/health", "/api/health"]);

/**
 * Workspace-management routes that must work without a resolvable workspace
 * database (portal list, pre-creation DB probe, screen-lock setup). Shared by
 * the PIN gate and the tenant-DB routing hook so both agree on the boundary.
 */
export function isWorkspaceManagementPath(path: string): boolean {
  return (
    path === "/api/workspaces" ||
    path === "/api/workspaces/database/test" ||
    /^\/api\/workspaces\/[^/]+\/screen-lock$/.test(path)
  );
}

function isExemptPath(url: string): boolean {
  return PUBLIC_PATHS.has(url.split("?")[0]);
}

function extractPin(request: FastifyRequest): string {
  const pinHeader = (request.headers["x-pin"] as string) || "";
  if (pinHeader) return pinHeader.trim();
  return "";
}

function sendUnauthorized(reply: FastifyReply): void {
  void reply.status(401).send({
    statusCode: 401,
    error: "Unauthorized",
    message:
      "Screenlock is enabled. Provide the x-pin header. " +
      "Query-string PIN is disabled (desktop hardening). " +
      "Configure the PIN via Workspace settings or the LOCAL_PIN env var.",
  });
}

export async function requirePin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === "OPTIONS") return;
  if (isExemptPath(request.url)) return;

  const pin = extractPin(request);
  const global = getGlobalPin();

  // 1. Global LOCAL_PIN env var (operator override):
  if (global !== null) {
    if (pin && pin === global) {
      (request as any).userId = "local-user";
      (request as any).workspaceId = (request as any).workspaceId || "default";
      return;
    }
    if (pin && (await matchesWorkspacePin(pin))) {
      (request as any).userId = "local-user";
      (request as any).workspaceId = (request as any).workspaceId || "default";
      return;
    }
    sendUnauthorized(reply);
    return;
  }

  // 2. Specific workspace targeted via header or request property
  const wsIdHeader = request.headers["x-workspace-id"];
  const rawWsId = (request as any).workspaceId || (Array.isArray(wsIdHeader) ? wsIdHeader[0] : wsIdHeader);
  if (rawWsId && typeof rawWsId === "string" && rawWsId.trim()) {
    const targetWsId = rawWsId.trim();
    let hash: string | null = null;
    if (workspacePinResolver) {
      try {
        hash = await workspacePinResolver(targetWsId);
      } catch {}
    }
    if (!hash) {
      const entries = await loadWorkspacePinEntriesCached();
      const match = entries.find((e) => e.id === targetWsId);
      hash = match?.hash ?? null;
    }

    if (hash) {
      if (pin && (await verifyScreenLockPinAsync(pin, hash))) {
        (request as any).userId = "local-user";
        return;
      }
      sendUnauthorized(reply);
      return;
    }

    // This workspace has no PIN -> allow!
    (request as any).userId = "local-user";
    return;
  }

  // 3. No specific workspace targeted (portal, general endpoints)
  // If no screenlock is configured anywhere, allow:
  if (!(await isScreenLockConfigured())) {
    (request as any).userId = "local-user";
    (request as any).workspaceId = (request as any).workspaceId || "default";
    return;
  }

  // If a pin was presented and matches any workspace, allow:
  if (pin && (await matchesWorkspacePin(pin))) {
    (request as any).userId = "local-user";
    (request as any).workspaceId = (request as any).workspaceId || "default";
    return;
  }

  // If on a workspace-management route (like listing workspaces on the portal), allow if no PIN was sent:
  const path = request.url.split("?")[0];
  if (!pin && isWorkspaceManagementPath(path)) {
    (request as any).userId = "local-user";
    (request as any).workspaceId = (request as any).workspaceId || "default";
    return;
  }

  // Screenlock is configured and candidate was wrong or missing on protected route:
  sendUnauthorized(reply);
}

/** Test seam: the effective global PIN (null = unset). Workspace state needs a DB. */
export function getPinForTests(): string | null {
  return getGlobalPin();
}

export const pinGate = {
  requirePin,
  getPin: getPinForTests,
  getGlobalPin,
  isScreenLockConfigured,
  matchesWorkspacePin,
  invalidatePinCache,
  hashScreenLockPin,
  verifyScreenLockPin,
  validateScreenLockPin,
  setWorkspacePinResolver,
};
