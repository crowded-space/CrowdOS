// â”€â”€â”€ Workspace Sandbox Runtime Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type WorkspaceStatus = "CREATED" | "INITIALIZING" | "ACTIVE" | "PAUSED" | "TERMINATED" | "ARCHIVED";
export type WorkspaceScope = "private" | "shared" | "readonly" | "ephemeral";

export interface WorkspacePermissions {
  network: boolean;
  shell: boolean;
  maxAgents: number;
}

export interface RuntimeConstraints {
  networkAccess: boolean;
  shellExecution: boolean;
  memoryLimitMb: number;
  cpuLimit: number;
}

export interface FilesystemPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  status: WorkspaceStatus;
  rootPath: string;
  permissions: WorkspacePermissions;
  constraints: RuntimeConstraints;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  ownerId?: string;
  permissions?: Partial<WorkspacePermissions>;
  constraints?: Partial<RuntimeConstraints>;
  metadata?: Record<string, unknown>;
}

export interface MountAgentInput {
  agentId: string;
  scope?: WorkspaceScope;
  permissions?: Partial<FilesystemPermissions>;
}

export interface ScreenLockStatus {
  workspaceId: string;
  enabled: boolean;
}
