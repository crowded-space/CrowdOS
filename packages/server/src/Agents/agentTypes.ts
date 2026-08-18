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
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: AuthorityLevel;
  l3Subtype?: L3Subtype;

  // Module references (identity-only)
  modelModuleId: string;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentProfileInput {
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: AuthorityLevel;
  l3Subtype?: L3Subtype;
  modelModuleId: string;
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
}

export interface UpdateAgentProfileInput {
  name?: string;
  title?: string;
  species?: string | null;
  avatar?: string | null;
  authorityLevel?: AuthorityLevel;
  l3Subtype?: L3Subtype | null;
  modelModuleId?: string;
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
}

export interface AgentRegistryFilters {
  authorityLevel?: AuthorityLevel;
  status?: AgentStatus;
  isTemplate?: boolean;
}
