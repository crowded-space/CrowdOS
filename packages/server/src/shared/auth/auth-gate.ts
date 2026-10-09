import type { FastifyRequest, FastifyReply } from "fastify";

import { verifyKey, createApiKey, revokeKey, seedBootstrapAdminKey, generateApiKey, hashApiKey, verifyHashMatch, API_KEY_PREFIX } from "./api-key-service.js";
import { isLoopbackPeer } from "../core/loopback.js";
import { isWorkspaceManagementPath } from "./pin-gate.js";
import type { ApiKeyRecord, ApiKeyRole } from "./api-key-service.js";

export { verifyKey, createApiKey, revokeKey, seedBootstrapAdminKey, generateApiKey, hashApiKey, verifyHashMatch, API_KEY_PREFIX };
export type { ApiKeyRecord, ApiKeyRole };

/**
 * SEC-1 authentication gate — strict-only (default-deny API-key auth).
 */
const ROLE_RANK: Record<ApiKeyRole, number> = { viewer: 1, operator: 2, admin: 3 };

declare module "fastify" {
  interface FastifyRequest {
    identity?: ApiKeyRecord;
  }
}

export function isStrictAuth(): boolean {
  return true;
}

function isExemptPath(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health" || path === "/api/health";
}

/**
 * The pre-key portal / workspace-discovery surface (CrowdOS §2 portal flow).
 *
 * These routes must answer BEFORE a caller can know a key, because they are how
 * the portal enumerates and enters a workspace. READ-ONLY discovery only:
 * mutating workspace operations stay behind the gate, and the desktop app still
 * reaches those through loopback trust.
 *
 * The workspace-path boundary itself is NOT redefined here — it is imported from
 * the PIN gate, which already owns the canonical `isWorkspaceManagementPath`
 * list shared with the tenant-DB routing hook. A second parallel list would be
 * free to drift from that one, and the two must agree or the portal breaks in a
 * way neither gate can see. This function only narrows that shared boundary by
 * method and adds the one read the portal needs that the shared list lacks.
 */
function isPortalDiscoveryPath(method: string, path: string): boolean {
  // Shared boundary: GET list, GET screen-lock status, the DB probe path.
  if (isWorkspaceManagementPath(path)) {
    // The probe is POST-only and read-only; the shared list is method-agnostic.
    if (path === "/api/workspaces/database/test") return method === "POST" || method === "GET";
    // Every other shared path is exempt for READS only. In particular
    // POST /api/workspaces (create) and the screen-lock WRITE endpoints stay
    // behind the gate.
    return method === "GET";
  }
  // GET /api/workspaces/:id — entering a workspace from the portal. Not in the
  // shared list because the tenant-routing hook does not need it, but the portal
  // cannot resolve which workspace to enter without it.
  return method === "GET" && /^\/api\/workspaces\/[^/]+$/.test(path);
}

function extractApiKey(request: FastifyRequest): string {
  const authHeader = (request.headers["authorization"] as string) || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const headerKey = (request.headers["x-api-key"] as string) || "";
  // B5: query-key channel dropped. ?api_key leaks keys into server logs,
  // browser history, and referers. Bearer / x-api-key headers only.
  return headerKey.trim();
}

function sendUnauthorized(reply: FastifyReply): void {
  void reply.status(401).send({
    statusCode: 401,
    error: "Unauthorized",
    message: "Missing or invalid API key.",
  });
}

async function requireAuthStrict(request: FastifyRequest, reply: FastifyReply) {
  if (request.method === "OPTIONS") return;
  if (isExemptPath(request.url)) return;

  const key = extractApiKey(request);
  if (!key) {
    sendUnauthorized(reply);
    return;
  }

  let record: ApiKeyRecord | null = null;
  try {
    record = await verifyKey(key);
  } catch {
    record = null;
  }
  if (!record) {
    sendUnauthorized(reply);
    return;
  }

  // Identity resolved server-side from the key row; client identity headers are not trusted.
  request.identity = record;
  (request as any).userId = `apikey:${record.id}`;
  (request as any).workspaceId = (request as any).workspaceId || "default";
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  return requireAuthStrict(request, reply);
}

/**
 * Mounted default-deny gate for the global onRequest hook (CrowdOS §19).
 *
 * Layered trust, most-specific first:
 *   1. Liveness probes and the pre-key portal/discovery surface are exempt.
 *   2. A presented API key is verified; success resolves identity server-side.
 *   3. No key + LOOPBACK peer is trusted — the same trust boundary the socket
 *      handshake already applies (shared/sockets/socket-auth.ts), and the reason
 *      the embedded desktop backend keeps working keylessly. The desktop
 *      listener is loopback-only, so this grants nothing to remote callers.
 *   4. Everything else is denied with the strict 401 shape.
 *
 * Identity is only ever derived from a verified key or from the peer address —
 * client-declared identity headers are never trusted.
 */
export async function requireAuthMounted(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === "OPTIONS") return;
  const path = String(request.url || "").split("?")[0];
  if (isExemptPath(request.url)) return;
  if (isPortalDiscoveryPath(request.method, path)) return;

  const key = extractApiKey(request);
  if (key) {
    let record: ApiKeyRecord | null = null;
    try {
      record = await verifyKey(key);
    } catch {
      record = null;
    }
    if (record) {
      request.identity = record;
      (request as any).userId = `apikey:${record.id}`;
      (request as any).workspaceId = (request as any).workspaceId || "default";
      return;
    }
    // A wrong key on a loopback peer still fails: an explicitly presented
    // credential is authoritative, so a bad key cannot be laundered by address.
    sendUnauthorized(reply);
    return;
  }

  if (isLoopbackPeer(request.ip)) {
    (request as any).userId = "loopback-user";
    (request as any).workspaceId = (request as any).workspaceId || "default";
    return;
  }

  sendUnauthorized(reply);
}

/**
 * Role gate usable as a Fastify preHandler. Hierarchy: viewer < operator < admin.
 */
export function requireRole(minimum: ApiKeyRole) {
  const minimumRank = ROLE_RANK[minimum];
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const role = request.identity?.role;
    if (!role || ROLE_RANK[role] < minimumRank) {
      await reply.status(403).send({
        statusCode: 403,
        error: "Forbidden",
        message: `Requires ${minimum} role.`,
      });
    }
  };
}

/**
 * Admin gate. Strict-only: requires an api_keys row with role='admin'.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (reply.sent) return;
  const role = request.identity?.role;
  if (role !== "admin") {
    await reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Admin privileges required." });
  }
}

export const authGate = {
  requireAuth,
  /** Global onRequest hook (default-deny + loopback trust + portal exemptions). */
  requireAuthMounted,
  requireAdmin,
  requireRole,
  isStrictAuth,
  isPortalDiscoveryPath,
  isLoopbackPeer,
  verifyKey,
  createApiKey,
  revokeKey,
  seedBootstrapAdminKey,
};
