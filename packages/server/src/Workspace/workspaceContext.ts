import { eq } from "drizzle-orm";

import { getDb } from "../Shared/config/database.js";
import { workspaceAgents, workspaces } from "../db/schema.js";

/**
 * Thrown when workspace-owned code executes without an explicit workspace.
 * There is no silent fallback to `"default"` — callers must resolve the
 * workspace from the request/socket/job first. The literal `"default"` id
 * remains valid wherever it names the real seeded workspace row.
 */
export class WorkspaceContextRequiredError extends Error {
  readonly code = "workspace_context_required" as const;
  readonly statusCode = 400;

  constructor(detail = "workspaceId is required") {
    super(detail);
    this.name = "WorkspaceContextRequiredError";
  }
}

/** Require a non-blank workspace id; throw instead of defaulting. */
export function requireWorkspaceId(value: unknown, detail?: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceContextRequiredError(detail);
  }
  return value;
}

/** Ownership check for workspace-owned rows (runs, artifacts, channels...). */
export function assertWorkspaceMatch(
  actual: unknown,
  expectedWorkspaceId: string,
  what = "object",
): void {
  if (actual !== expectedWorkspaceId) {
    throw new WorkspaceContextRequiredError(`${what} does not belong to workspace ${expectedWorkspaceId}`);
  }
}

/** Registry check: the requested workspace must exist. */
export async function assertWorkspaceExists(workspaceId: string): Promise<void> {
  const row = await getDb().query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!row || (row as { id?: string }).id !== workspaceId) {
    throw new WorkspaceContextRequiredError(`Unknown workspace ${workspaceId}`);
  }
}

interface HttpWorkspaceSource {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: unknown;
}

/**
 * Resolve the workspace for an HTTP request: `x-workspace-id` header, then
 * body/query `workspaceId`, then the seeded `"default"` workspace (explicit
 * legacy single-workspace scope — never an invented fallback id).
 */
export function resolveHttpWorkspaceId(request: HttpWorkspaceSource): string {
  const header = request.headers?.["x-workspace-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === "string" && headerValue.trim() !== "") return headerValue;
  const body = request.body as { workspaceId?: unknown } | undefined;
  if (typeof body?.workspaceId === "string" && body.workspaceId.trim() !== "") return body.workspaceId;
  const query = request.query as { workspaceId?: unknown } | undefined;
  if (typeof query?.workspaceId === "string" && query.workspaceId.trim() !== "") return query.workspaceId;
  return "default";
}

/** Resolve + verify existence (400 on unknown). Use for mutations. */
export async function requireHttpWorkspace(request: HttpWorkspaceSource): Promise<string> {
  const workspaceId = resolveHttpWorkspaceId(request);
  await assertWorkspaceExists(workspaceId);
  return workspaceId;
}

/** Roster source of truth: agent ids mounted into the workspace. */
export async function getMountedAgentIds(workspaceId: string): Promise<string[]> {
  const rows = await getDb().query.workspaceAgents.findMany({
    where: eq(workspaceAgents.workspaceId, workspaceId),
  });
  return rows.map((r) => r.agentId);
}
