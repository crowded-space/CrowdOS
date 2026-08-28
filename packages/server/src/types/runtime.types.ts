export type RuntimeOverrideType = "runtime_patch" | "temp_permission" | "context_inject";

export interface InstructionPatch {
  append?: string[];
  replace?: string[];
  /** CTX-2 scoped replace: if set, replace only the target module's slice, not the whole stack */
  targetModuleId?: string;
  /** Alias for targetModuleId (backward compat) */
  replaceTarget?: string;
}

export interface PermissionPatch {
  grantTools?: string[];
  revokeTools?: string[];
}

export interface RuntimeOverride {
  id: string;
  targetAgentId: string;
  overrideType: RuntimeOverrideType;
  instructionPatch?: InstructionPatch;
  permissionPatch?: PermissionPatch;
  createdBy: string;
  expiresAt?: Date;
  createdAt: Date;
}

export type RuntimeStatus = "idle" | "working" | "paused" | "offline";

export interface RuntimeState {
  sessionId: string;
  agentId: string;
  status: RuntimeStatus;
  activeTask?: string;
  activeChannelId?: string;
  startedAt?: Date;
  overridesApplied: string[];
  lastHeartbeat?: Date;
  createdAt: Date;
}
