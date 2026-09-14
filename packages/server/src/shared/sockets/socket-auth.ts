import type { IncomingHttpHeaders } from "node:http";

import { verifyKey } from "../auth/api-key-service.js";
import type { ApiKeyRole } from "../../db/schema.js";

/**
 * SEC-2 socket trust — strict-only: identity is resolved exclusively from the
 * handshake credential, never from client-declared userId/workspaceId claims.
 */

export interface SocketIdentity {
  mode: "apikey";
  userId: string;
  workspaceId: string;
  keyId?: string;
  label?: string | null;
  role?: ApiKeyRole;
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

/**
 * Returns the verified identity for a handshake, or null when the handshake
 * must be rejected.
 */
export async function resolveSocketIdentity(handshake: {
  auth?: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}): Promise<SocketIdentity | null> {
  const auth = handshake.auth || {};
  const headers = handshake.headers || {};
  const key = extractHandshakeKey(auth, headers);
  if (!key) return null;
  let record: Awaited<ReturnType<typeof verifyKey>> = null;
  try {
    record = await verifyKey(key);
  } catch {
    record = null;
  }
  if (!record) return null;
  return {
    mode: "apikey",
    userId: `apikey:${record.id}`,
    workspaceId: "default",
    keyId: record.id,
    label: record.label,
    role: record.role,
  };
}
