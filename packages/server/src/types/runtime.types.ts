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

export type RuntimeStatus = "idle" | "working" | "paused" | "offline";
