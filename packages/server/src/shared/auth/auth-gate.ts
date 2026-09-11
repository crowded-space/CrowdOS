import type { FastifyRequest, FastifyReply } from "fastify";

import { verifyKey } from "./api-key-service.js";
import type { ApiKeyRecord, ApiKeyRole } from "./api-key-service.js";

/**
 * SEC-1 authentication gate.
 *
 * Strict mode (default): every non-exempt request must present a valid API
 * key (`Authorization: Bearer <key>`, `X-API-Key`, or `?api_key=`). Identity
 * is resolved server-side from the api_keys row; spoofable x-user-id style
 * headers are ignored entirely.
 *
 * Legacy shared-token mode (AUTH_STRICT=false): previous behavior preserved
 * verbatim for rollback — AUTH_TOKEN/API_KEY match, open-in-dev when unset.
 */

const AUTH_STRICT = (process.env.AUTH_STRICT ?? "true").trim().toLowerCase() !== "false";
const AUTH_TOKEN = process.env.AUTH_TOKEN || process.env.API_KEY || "";
const ROLE_RANK: Record<ApiKeyRole, number> = { viewer: 1, operator: 2, admin: 3 };

declare module "fastify" {
  interface FastifyRequest {
    identity?: ApiKeyRecord;
  }
}

export function isStrictAuth(): boolean {
  if (process.env.DESKTOP_MODE === "1") return false;
  return AUTH_STRICT;
}

export function getAuthToken(): string | null {
  return AUTH_TOKEN || null;
}

function isExemptPath(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health" || path === "/api/health";
}

function extractApiKey(request: FastifyRequest): string {
  const authHeader = (request.headers["authorization"] as string) || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const headerKey = (request.headers["x-api-key"] as string) || "";
  if (headerKey) return headerKey.trim();
  const queryKey = (request.query as Record<string, unknown> | null)?.api_key;
  return typeof queryKey === "string" ? queryKey.trim() : "";
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

async function requireAuthLegacy(request: FastifyRequest, reply: FastifyReply) {
  if (!AUTH_TOKEN) {
    if (!(global as any).__authWarned) {
      request.log.warn("[AUTH] AUTH_TOKEN not set — API is unauthenticated (dev mode). Set AUTH_TOKEN env to enforce auth.");
      (global as any).__authWarned = true;
    }
    (request as any).userId = (request.headers["x-user-id"] as string) || "user-1";
    return;
  }

  const headerApiKey = (request.headers["x-api-key"] as string) || "";
  const authHeader = (request.headers["authorization"] as string) || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  const provided = headerApiKey || bearer || (request.headers["x-admin-token"] as string) || "";

  if (provided !== AUTH_TOKEN) {
    return reply.status(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing or invalid authentication token. Provide x-api-key or Authorization: Bearer <token>.",
    });
  }

  (request as any).userId = (request.headers["x-user-id"] as string) || "authenticated_user";
  (request as any).workspaceId = (request.headers["x-workspace-id"] as string) || "default";
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (AUTH_STRICT) return requireAuthStrict(request, reply);
  return requireAuthLegacy(request, reply);
}

export async function requireWorkspaceAccess(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (reply.sent) return;
  const workspaceId = (request.params as any)?.workspaceId || (request.query as any)?.workspaceId || (request as any).workspaceId || "default";
}

/**
 * Role gate usable as a Fastify preHandler. Hierarchy: viewer < operator < admin.
 * Strict mode reads the role off the verified api_keys row. Legacy mode
 * (AUTH_STRICT=false) lets any authenticated request through for rollback parity.
 */
export function requireRole(minimum: ApiKeyRole) {
  const minimumRank = ROLE_RANK[minimum];
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!AUTH_STRICT) return;

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
 * Admin gate. Strict mode requires an api_keys row with role='admin'.
 * Legacy mode keeps the original WORKSPACE_ADMIN_TOKEN semantics verbatim.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (reply.sent) return;

  if (AUTH_STRICT) {
    const role = request.identity?.role;
    if (role !== "admin") {
      await reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Admin privileges required." });
    }
    return;
  }

  const adminToken = process.env.WORKSPACE_ADMIN_TOKEN;
  if (!adminToken) {
    return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Admin access not configured. Set WORKSPACE_ADMIN_TOKEN." });
  }
  const provided = (request.headers["x-admin-token"] as string) || (request.headers["authorization"] as string)?.replace(/^Bearer\s+/i, "") || "";
  if (provided !== adminToken && provided !== AUTH_TOKEN) {
    return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Admin privileges required." });
  }
}

export const authGate = {
  requireAuth,
  requireWorkspaceAccess,
  requireAdmin,
  requireRole,
  getAuthToken,
  isStrictAuth,
};
