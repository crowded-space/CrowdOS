import { WorkspaceManager } from "./workspaceManager.js";
import {
  PermissionError,
  WorkspaceNotActiveError,
  assertWorkspaceActive,
  assertPermission,
  assertCanRead,
  assertCanWrite,
  assertCanExecute,
  validateAgentAccess,
} from "./permissionGuard.js";

export type {
  WorkspaceStatus,
  WorkspaceScope,
  ArtifactType,
  WorkspaceNodeType,
  WorkspacePermissions,
  RuntimeConstraints,
  VFSPermissions,
  Workspace,
  WorkspaceNode,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceAgentSession,
  Artifact,
  CreateWorkspaceInput,
  MountAgentInput,
  RegisterArtifactInput,
} from "./workspaceTypes.js";

export {
  WorkspaceManager,
  PermissionError,
  WorkspaceNotActiveError,
  assertWorkspaceActive,
  assertPermission,
  assertCanRead,
  assertCanWrite,
  assertCanExecute,
  validateAgentAccess,
};
import {
  WorkspaceContextRequiredError,
  requireWorkspaceId,
  assertWorkspaceMatch,
  assertWorkspaceExists,
  getMountedAgentIds,
  resolveHttpWorkspaceId,
  requireHttpWorkspace,
} from "./workspaceContext.js";

export {
  WorkspaceContextRequiredError,
  requireWorkspaceId,
  assertWorkspaceMatch,
  assertWorkspaceExists,
  getMountedAgentIds,
  resolveHttpWorkspaceId,
  requireHttpWorkspace,
};

export const workspaceGate = {
  requireId: requireWorkspaceId,
  assertMatch: assertWorkspaceMatch,
  assertExists: assertWorkspaceExists,
  getMountedAgentIds,
  resolveHttpWorkspaceId,
  requireHttpWorkspace,
};
