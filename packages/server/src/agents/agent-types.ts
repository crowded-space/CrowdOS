import type { RuntimeStatus } from "../types/runtime.types.js";

export type AuthorityLevel = 0 | 1 | 2 | 3;
export type AgentStatus = RuntimeStatus;
export type MemorySharingPolicy = "none" | "horizontal" | "vertical" | "full";
export type L3Subtype = "worker" | "supervisor";

export interface AgentAuthorityPermissions {
  spawnAgents: boolean;
  patchRuntime: boolean;
  accessAllChannels: boolean;
}

/** Identity-only AgentProfile for CrowdOS.
 *  All cognitive configuration (system prompt, model, tools) lives in referenced modules. */
export interface AgentProfile {
  id: string;
  /** Owning workspace (CrowdOS §1 isolation). Null = legacy global row. */
  workspaceId?: string | null;
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: AuthorityLevel;
  l3Subtype?: L3Subtype;

  // Module references (identity-only; null = unattached, e.g. Raven default)
  modelModuleId: string | null;
  instructionModuleId: string;
  toolkitModuleId?: string;
  constraintsModuleId?: string;
  capabilitiesModuleId?: string;

  memorySharingPolicy: MemorySharingPolicy;
  isOmniscient: boolean;
  fallbackAgentId?: string;
  categoryPermissions?: string[];

  permissions: AgentAuthorityPermissions;

  status: AgentStatus;
  isTemplate: boolean;
  /** Optional per-agent input context token cap (agent-context only). Null = unlimited / fallback to modelModule/policy. */
  contextTokenCap?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentProfileInput {
  workspaceId?: string | null;
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: AuthorityLevel;
  l3Subtype?: L3Subtype;
  modelModuleId: string | null;
  instructionModuleId: string;
  toolkitModuleId?: string;
  constraintsModuleId?: string;
  capabilitiesModuleId?: string;
  memorySharingPolicy: MemorySharingPolicy;
  isOmniscient?: boolean;
  fallbackAgentId?: string;
  categoryPermissions?: string[];
  permissions?: Partial<AgentAuthorityPermissions>;
  status?: AgentStatus;
  isTemplate?: boolean;
  contextTokenCap?: number | null;
}

export interface UpdateAgentProfileInput {
  workspaceId?: string | null;
  name?: string;
  title?: string;
  species?: string | null;
  avatar?: string | null;
  authorityLevel?: AuthorityLevel;
  l3Subtype?: L3Subtype | null;
  modelModuleId?: string | null;
  instructionModuleId?: string;
  toolkitModuleId?: string | null;
  constraintsModuleId?: string | null;
  capabilitiesModuleId?: string | null;
  memorySharingPolicy?: MemorySharingPolicy;
  isOmniscient?: boolean;
  fallbackAgentId?: string | null;
  categoryPermissions?: string[];
  permissions?: Partial<AgentAuthorityPermissions>;
  status?: AgentStatus;
  isTemplate?: boolean;
  contextTokenCap?: number | null;
}

export interface AgentRegistryFilters {
  workspaceId?: string | null;
  authorityLevel?: AuthorityLevel;
  status?: AgentStatus;
  isTemplate?: boolean;
  limit?: number;
  cursor?: string | null;
}
