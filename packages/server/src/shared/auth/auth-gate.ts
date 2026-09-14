import type { FastifyRequest, FastifyReply } from "fastify";

import { verifyKey } from "./api-key-service.js";
import type { ApiKeyRecord, ApiKeyRole } from "./api-key-service.js";

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

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  return requireAuthStrict(request, reply);
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
  requireAdmin,
  requireRole,
  isStrictAuth,
};
