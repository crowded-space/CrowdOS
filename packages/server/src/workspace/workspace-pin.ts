// ─── Workspace Screenlock PIN (internal) ─────────────────────────────
// Per-workspace opt-in screenlock. Only scrypt hashes are persisted
// (in local workspaces.json registry & optionally workspaces.screen_lock_pin_hash);
// plaintext PINs never touch the disk/DB.
// Crypto lives in Shared/auth/pin-gate (importable shared infra); this module
// owns the workspace-row read/write + API-safe sanitizing.

import { eq } from "drizzle-orm";

import { getDb } from "../shared/config/database.js";
import {
  getGlobalPin,
  hashScreenLockPin,
  validateScreenLockPin,
  verifyScreenLockPin,
} from "../shared/auth/pin-gate.js";
import { workspaces } from "../db/schema.js";
import { getWorkspaceRecord, saveWorkspaceRecord } from "./workspace-registry.js";
import type { ScreenLockStatus } from "./workspace-types.js";

/** Strip the PIN hash from a workspace row; expose only an `enabled` flag. */
export function sanitizeWorkspace<T extends Record<string, unknown>>(
  row: T,
): Omit<T, "screenLockPinHash"> & { screenLockEnabled: boolean } {
  const { screenLockPinHash, ...rest } = row as T & { screenLockPinHash?: unknown };
  return {
    ...(rest as Omit<T, "screenLockPinHash">),
    screenLockEnabled: typeof screenLockPinHash === "string" && screenLockPinHash.length > 0,
  };
}

async function loadHash(workspaceId: string): Promise<{ exists: boolean; hash: string | null }> {
  try {
    const record = await getWorkspaceRecord(workspaceId);
    if (record) {
      return { exists: true, hash: record.screenLockPinHash ?? null };
    }
  } catch {}

  try {
    const db = getDb();
    const row = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (row) {
      const hash = (row as { screenLockPinHash?: string | null }).screenLockPinHash ?? null;
      return { exists: true, hash };
    }
  } catch {}

  throw new Error(`Workspace ${workspaceId} not found`);
}

/** Get the stored PIN hash for a workspace (registry first, then db). */
export async function getWorkspacePinHash(workspaceId: string): Promise<string | null> {
  try {
    const { hash } = await loadHash(workspaceId);
    return hash;
  } catch {
    return null;
  }
}

/**
 * Current PIN check for change/disable flows. Accepts the stored workspace PIN
 * OR the global LOCAL_PIN env (so a global operator can rotate without knowing
 * the workspace PIN). When nothing is currently set, no proof is required.
 */
export function isCurrentPinAccepted(
  currentPin: string | undefined,
  storedHash: string | null,
): boolean {
  if (!storedHash) return true;
  if (typeof currentPin !== "string" || !currentPin.trim()) return false;
  if (verifyScreenLockPin(currentPin, storedHash)) return true;
  const global = getGlobalPin();
  return global !== null && currentPin.trim() === global;
}

export async function getScreenLockStatus(workspaceId: string): Promise<ScreenLockStatus> {
  const { hash } = await loadHash(workspaceId);
  return { workspaceId, enabled: typeof hash === "string" && hash.length > 0 };
}

export async function setScreenLockPin(
  workspaceId: string,
  pin: string,
  currentPin?: string,
): Promise<ScreenLockStatus> {
  const normalized = validateScreenLockPin(pin);
  const { hash } = await loadHash(workspaceId);
  if (hash && !isCurrentPinAccepted(currentPin, hash)) {
    throw new Error("Current screenlock PIN is incorrect.");
  }
  const hashedPin = hashScreenLockPin(normalized);

  // WS-002: honest persistence. At least one store must acknowledge the
  // write or the caller gets a 5xx instead of a false success. Registry is
  // authoritative for screenlock; DB sync stays best-effort but is tracked.
  let persisted = false;
  let registryError: unknown = null;
  try {
    const record = await getWorkspaceRecord(workspaceId);
    if (record) {
      record.screenLockPinHash = hashedPin;
      await saveWorkspaceRecord(record);
      persisted = true;
    }
  } catch (err) {
    registryError = err;
  }

  try {
    const db = getDb();
    await db
      .update(workspaces)
      .set({ screenLockPinHash: hashedPin, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    persisted = true;
  } catch {}

  if (!persisted) {
    throw new Error(
      `Failed to persist screenlock PIN for workspace ${workspaceId}` +
        (registryError instanceof Error ? `: ${registryError.message}` : "")
    );
  }

  // WS-001: drop the 15s pin-entries cache so the new PIN enforces immediately.
  const { invalidatePinCache } = await import("../shared/auth/pin-gate.js");
  invalidatePinCache();

  return { workspaceId, enabled: true };
}

export async function clearScreenLockPin(
  workspaceId: string,
  currentPin?: string,
): Promise<ScreenLockStatus> {
  const { hash } = await loadHash(workspaceId);
  if (hash && !isCurrentPinAccepted(currentPin, hash)) {
    throw new Error("Current screenlock PIN is incorrect.");
  }

  // WS-002 (clear path): same honest-persist + invalidate contract as set.
  let cleared = false;
  let registryError: unknown = null;
  try {
    const record = await getWorkspaceRecord(workspaceId);
    if (record) {
      record.screenLockPinHash = null;
      await saveWorkspaceRecord(record);
      cleared = true;
    }
  } catch (err) {
    registryError = err;
  }

  try {
    const db = getDb();
    await db
      .update(workspaces)
      .set({ screenLockPinHash: null, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    cleared = true;
  } catch {}

  if (!cleared) {
    throw new Error(
      `Failed to clear screenlock PIN for workspace ${workspaceId}` +
        (registryError instanceof Error ? `: ${registryError.message}` : "")
    );
  }

  const { invalidatePinCache } = await import("../shared/auth/pin-gate.js");
  invalidatePinCache();

  return { workspaceId, enabled: false };
}
