import type { IncomingHttpHeaders } from "node:http";

import { authGate } from "../auth/auth-gate.js";
import { isLoopbackPeer } from "../core/loopback.js";
import type { ApiKeyRole } from "../../db/schema.js";

/**
 * SEC-2 socket trust — key-first: identity is resolved from the handshake
 * credential, never from client-declared userId/workspaceId claims.
 * Keyless handshakes are accepted only from loopback peers (same-machine
 * single user — the same trust boundary as every REST route); the middleware
 * mints that identity server-side, it never honors client claims for it.
 */

export interface SocketIdentity {
  mode: "apikey" | "loopback";
  userId: string;
  workspaceId: string;
  keyId?: string;
  label?: string | null;
  role?: ApiKeyRole;
}

// §19 trust boundary: the predicate is shared with the REST auth gate so both
// transports provably agree on "same machine". Re-exported here because this
// module is the historical import site for socket callers and its tests.
export { isLoopbackPeer } from "../core/loopback.js";

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
  let record: Awaited<ReturnType<typeof authGate.verifyKey>> = null;
  try {
    record = await authGate.verifyKey(key);
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
