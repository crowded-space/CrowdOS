// ─── Permission Guard ────────────────────────────────────────────────
// Validates agent permissions for workspace operations.

import type { WorkspaceAgentSession, VFSPermissions, Workspace } from "./workspaceTypes.js";

export class PermissionError extends Error {
  public readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export class WorkspaceNotActiveError extends Error {
  public readonly statusCode = 409;
  constructor(workspaceId: string, status: string) {
    super(`Workspace ${workspaceId} is ${status}, not ACTIVE`);
    this.name = "WorkspaceNotActiveError";
  }
}

/**
 * Check if the workspace is in ACTIVE state.
 */
export function assertWorkspaceActive(workspace: Workspace): void {
  if (workspace.status !== "ACTIVE") {
    throw new WorkspaceNotActiveError(workspace.id, workspace.status);
  }
}

/**
 * Check if the agent session has the required permission.
 */
export function assertPermission(session: WorkspaceAgentSession, required: keyof VFSPermissions): void {
  if (!session.permissions[required]) {
    throw new PermissionError(
      `Agent ${session.agentId} lacks '${required}' permission in workspace ${session.workspaceId} (scope: ${session.scope})`,
    );
  }
}

/**
 * Check read permission.
 */
export function assertCanRead(session: WorkspaceAgentSession): void {
  assertPermission(session, "read");
}

/**
 * Check write permission.
 */
export function assertCanWrite(session: WorkspaceAgentSession): void {
  assertPermission(session, "write");
}

/**
 * Check execute permission.
 */
export function assertCanExecute(session: WorkspaceAgentSession): void {
  assertPermission(session, "execute");
}

/**
 * Validate that an agent is mounted and get their session.
 * Returns the session if valid, throws PermissionError otherwise.
 */
export function validateAgentAccess(
  sessions: WorkspaceAgentSession[],
  agentId: string,
  workspaceId: string,
): WorkspaceAgentSession {
  const session = sessions.find((s) => s.agentId === agentId);
  if (!session) {
    throw new PermissionError(`Agent ${agentId} is not mounted to workspace ${workspaceId}`);
  }
  return session;
}
