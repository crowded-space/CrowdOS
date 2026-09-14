import {
  getWorkspaceDb,
  closeWorkspaceDatabase,
  closeAllWorkspaceDatabases,
  getWorkspaceDbPoolStats,
  forEachWorkspaceDb,
} from "./workspace-database-runtime.js";
import {
  parseWorkspaceDatabaseUrl,
  describeWorkspaceDatabaseUrl,
  testWorkspaceDatabaseConnection,
  provisionWorkspaceDatabase,
  withProvisionLock,
  seedWorkspacePresets,
  resetWorkspaceDatabase,
  upsertWorkspaceDatabaseEnv,
  removeWorkspaceDatabaseEnv,
  resolveWorkspaceEnvFilePath,
} from "./workspace-database.js";
import {
  listWorkspaces,
  listWorkspaceRecords,
  getWorkspaceRecord,
  getWorkspaceDescriptor,
  saveWorkspaceRecord,
  removeWorkspaceRecord,
} from "./workspace-registry.js";
import {
  getScreenLockStatus,
  getWorkspacePinHash,
  setScreenLockPin,
  clearScreenLockPin,
  sanitizeWorkspace,
} from "./workspace-pin.js";

export type {
  WorkspaceStatus,
  WorkspaceScope,
  WorkspaceNodeType,
  WorkspacePermissions,
  RuntimeConstraints,
  VFSPermissions,
  Workspace,
  WorkspaceNode,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceAgentSession,
  CreateWorkspaceInput,
  MountAgentInput,
  ScreenLockStatus,
} from "./workspace-types.js";

export type {
  WorkspaceRecord,
  WorkspaceDescriptor,
} from "./workspace-registry.js";

export {
  getWorkspaceDb,
  closeWorkspaceDatabase,
  closeAllWorkspaceDatabases,
  getWorkspaceDbPoolStats,
  forEachWorkspaceDb,
  parseWorkspaceDatabaseUrl,
  describeWorkspaceDatabaseUrl,
  testWorkspaceDatabaseConnection,
  provisionWorkspaceDatabase,
  provisionWorkspaceDatabase as provisionWorkspaceDatabaseSchema,
  withProvisionLock,
  seedWorkspacePresets,
  resetWorkspaceDatabase,
  upsertWorkspaceDatabaseEnv,
  removeWorkspaceDatabaseEnv,
  resolveWorkspaceEnvFilePath,
  listWorkspaces,
  listWorkspaceRecords,
  getWorkspaceRecord,
  getWorkspaceDescriptor,
  saveWorkspaceRecord,
  removeWorkspaceRecord,
  getScreenLockStatus,
  getWorkspacePinHash,
  setScreenLockPin,
  clearScreenLockPin,
  sanitizeWorkspace,
};
