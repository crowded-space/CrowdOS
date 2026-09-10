import type { IncomingHttpHeaders } from "node:http";

import { getAuthToken, isStrictAuth } from "../auth/authGate.js";
import { verifyKey } from "../auth/apiKeyService.js";
import type { ApiKeyRole } from "../../db/schema.js";

/**
 * SEC-2 socket trust: identity is resolved exclusively from the handshake
 * credential, never from client-declared userId/workspaceId claims.
 *
 * Modes:
 * - "apikey"  AUTH_STRICT=true (default): handshake must carry a valid CrowdOS
 *   API key; identity mirrors the HTTP gate (userId = `apikey:<id>`).
 * - "legacy"  AUTH_STRICT=false: shared-token parity with requireAuthLegacy,
 *   including the open-in-dev fallback when AUTH_TOKEN/API_KEY are unset.
 * - "open"    SOCKET_OPEN=true AND not production: pre-SEC-2 behavior restored
 *   wholesale (rollback escape hatch) — no credential required and client
 *   identity claims are honored exactly as they used to be. Dev only.
 */

export interface SocketIdentity {
  mode: "apikey" | "legacy" | "open";
  userId: string;
  workspaceId: string;
  keyId?: string;
  label?: string | null;
  role?: ApiKeyRole;
}

let openModeWarned = false;

export function isOpenSocketMode(): boolean {
  return process.env.SOCKET_OPEN === "true" && process.env.NODE_ENV !== "production";
}

export function extractHandshakeKey(
  auth: Record<string, unknown> | undefined,
  headers: IncomingHttpHeaders,
): string {
  const authKey = auth && typeof auth.key === "string" ? auth.key.trim() : "";
  if (authKey) return authKey;
  const authToken = auth && typeof auth.token === "string" ? auth.token.trim() : "";
  if (authToken) return authToken;
  const authorization = headers["authorization"];
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  const apiKeyHeader = headers["x-api-key"];
  if (typeof apiKeyHeader === "string") return apiKeyHeader.trim();
  return "";
}

function headerStr(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function claimStr(auth: Record<string, unknown> | undefined, name: string): string {
  const value = auth?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Returns the verified identity for a handshake, or null when the handshake
 * must be rejected under the active auth mode.
 */
export async function resolveSocketIdentity(handshake: {
  auth?: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}): Promise<SocketIdentity | null> {
  const auth = handshake.auth || {};
  const headers = handshake.headers || {};

  if (isOpenSocketMode()) {
    if (!openModeWarned) {
      console.warn("[SocketAuth] SOCKET_OPEN=true — socket authentication disabled (dev-only rollback mode). Never enable in production.");
      openModeWarned = true;
    }
    return {
      mode: "open",
      userId: claimStr(auth, "userId") || headerStr(headers, "x-user-id") || "user-1",
      workspaceId: claimStr(auth, "workspaceId") || headerStr(headers, "x-workspace-id") || "default",
    };
  }

  if (isStrictAuth()) {
    const key = extractHandshakeKey(auth, headers);
    if (!key) return null;
    let record: Awaited<ReturnType<typeof verifyKey>> = null;
    try {
      record = await verifyKey(key);
    } catch {
      record = null;
    }
    if (!record) return null;
    // Workspace comes from the handshake request (auth claim or header),
    // verified against the registry — never silently forced to "default".
    const requested =
      claimStr(auth, "workspaceId") || headerStr(headers, "x-workspace-id") || "";
    if (!requested) return null;
    try {
      const { getDb } = await import("../config/database.js");
      const { workspaces } = await import("../../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const ws = await getDb().query.workspaces.findFirst({
        where: eq(workspaces.id, requested),
      });
      // Compare ids explicitly (not just truthiness) so stores that ignore
      // the WHERE clause still enforce the check.
      if (!ws || (ws as { id?: string }).id !== requested) return null;
    } catch {
      return null;
    }
    return {
      mode: "apikey",
      userId: `apikey:${record.id}`,
      workspaceId: requested,
      keyId: record.id,
      label: record.label,
      role: record.role,
    };
  }

  // Legacy shared-token mode — parity with requireAuthLegacy in Shared/auth/authGate.ts.
  const legacyToken = getAuthToken();
  if (!legacyToken) {
    return {
      mode: "legacy",
      userId: claimStr(auth, "userId") || headerStr(headers, "x-user-id") || "user-1",
      workspaceId: claimStr(auth, "workspaceId") || headerStr(headers, "x-workspace-id") || "default",
    };
  }

  const provided = extractHandshakeKey(auth, headers) || headerStr(headers, "x-admin-token");
  if (provided !== legacyToken) return null;

  return {
    mode: "legacy",
    userId: headerStr(headers, "x-user-id") || claimStr(auth, "userId") || "authenticated_user",
    workspaceId: headerStr(headers, "x-workspace-id") || claimStr(auth, "workspaceId") || "default",
  };
}
