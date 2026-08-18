// ─── Workspace Sandbox Runtime Types ─────────────────────────────────

export type WorkspaceStatus = "CREATED" | "INITIALIZING" | "ACTIVE" | "PAUSED" | "TERMINATED" | "ARCHIVED";
export type WorkspaceScope = "private" | "shared" | "readonly" | "ephemeral";
export type ArtifactType = "reasoning_trace" | "execution_log" | "analysis_report" | "generated_component" | "task_result" | "runtime_snapshot";
export type WorkspaceNodeType = "file" | "directory";

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

export interface VFSPermissions {
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

export interface WorkspaceNode {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  type: WorkspaceNodeType;
  mimeType: string | null;
  size: number;
  checksum: string | null;
  createdBy: string;
  updatedBy: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceEvent {
  id: string;
  workspaceId: string;
  type: string;
  agentId: string | null;
  path: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type WorkspaceEventType =
  | "workspace.created"
  | "workspace.deleted"
  | "file.created"
  | "file.updated"
  | "file.deleted"
  | "file.renamed"
  | "agent.joined"
  | "agent.left"
  | "artifact.created"
  | "execution.started"
  | "execution.finished"
  | "execution.failed";

export interface WorkspaceAgentSession {
  id: string;
  workspaceId: string;
  agentId: string;
  scope: WorkspaceScope;
  permissions: VFSPermissions;
  createdAt: Date;
}

export interface Artifact {
  id: string;
  workspaceId: string;
  producerAgent: string;
  artifactType: ArtifactType;
  path: string | null;
  semanticTags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
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
  permissions?: Partial<VFSPermissions>;
}

export interface RegisterArtifactInput {
  producerAgent: string;
  artifactType: ArtifactType;
  path?: string;
  semanticTags?: string[];
  metadata?: Record<string, unknown>;
}
