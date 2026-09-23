// ─── Local-Mode HTTP Guard (dual-boot honesty) ─────────────────────────
// Entities with no local tier (module/skill/provider catalogs, global
// settings/budget singletons) fail honestly in local mode instead of raw
// 500s: list-GETs degrade to empty shapes the client fan-out needs, writes
// (and other reads) answer 501/503 with a Connect-DB suggestion.
// ponytail: one prefix table, not per-route edits; threads/search/safety/
// studio stay untouched (documented pending, advanced surfaces only).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { tierContextFor } from "../../workspace/workspace-gate.js";
import { resolveTier } from "../config/database.js";

const CONNECT_DB_SUGGESTION =
  "Connect a database to this workspace (Workspace Overview → Database) to enable provider modules, skills, budgets, and semantic memory. Chat, channels, and files keep working locally.";

function emptyShape(path: string): { empty: true; body: unknown } | null {
  if (path === "/api/providers/generation") return { empty: true, body: [] };
  if (path === "/api/skills") return { empty: true, body: [] };
  return null;
}

// /api/modules left the guard: module catalogs now have a local file tier
// (module-local-store), so reads and writes serve local truth like agents.
const GUARDED_PREFIXES = [
  "/api/skills",
  "/api/providers",
  "/api/workspace/settings",
  "/api/workspace/budget",
];

/** True when the request targets a PG-only surface. */
export function isPgOnlyPath(path: string): boolean {
  const clean = path.split("?")[0];
  return GUARDED_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`));
}

/** 503 payload shared by the guard and resolveRequestDb. */
export function localModeDegraded(what: string): { statusCode: number; error: string; code: string; message: string; suggestion: string } {
  return {
    statusCode: 503,
    error: "Service Unavailable",
    code: "LOCAL_MODE_DEGRADED",
    message: `${what} requires a database connection; this workspace is running on local files.`,
    suggestion: CONNECT_DB_SUGGESTION,
  };
}

/**
 * Fastify hook: PG-only surfaces degrade honestly in local tier.
 * List-GETs with known empty shapes return 200-empty (client fan-out needs
 * them); everything else guarded answers 501 with the Connect-DB suggestion.
 */
export async function registerLocalModeGuard(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest & { workspaceId?: string }, reply: any) => {
    const url = String((request as any).url || "").split("?")[0];
    if (!isPgOnlyPath(url)) return;
    const wsIdHeader = request.headers["x-workspace-id"];
    const headerWsId = Array.isArray(wsIdHeader) ? wsIdHeader[0] : wsIdHeader;
    const workspaceId =
      (request as any).workspaceId || (typeof headerWsId === "string" && headerWsId.trim()) || null;
    const ctx = await tierContextFor(workspaceId).catch(() => null);
    const { tier } = resolveTier(ctx ?? {});
    if (tier !== "local") return;
    if (request.method === "GET") {
      const shape = emptyShape(url);
      if (shape) {
        reply.header("x-local-mode", "degraded-empty");
        return reply.send(shape.body);
      }
    }
    return reply.status(501).send({
      statusCode: 501,
      error: "Not Implemented",
      code: "LOCAL_MODE_DEGRADED",
      message: `${request.method} ${url} requires a database connection; this workspace is running on local files.`,
      suggestion: CONNECT_DB_SUGGESTION,
    });
  });
}
