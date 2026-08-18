import { z } from "zod";

// ==========================================
// MODULE SYSTEM SCHEMAS & CONTRACTS
// ==========================================

export const ProviderEngineSchema = z.enum(["google", "openai", "anthropic", "ollama", "custom"]);
export type ProviderEngine = z.infer<typeof ProviderEngineSchema>;

export const ModelModuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: ProviderEngineSchema,
  modelName: z.string(),
  apiKey: z.string().optional().nullable(),
  endpointUrl: z.string().optional().nullable(),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxOutputTokens: z.number().int().positive(),
  stopSequences: z.array(z.string()).default([]),
  maxRecentMessages: z.number().int().nonnegative(),
  enableCompression: z.boolean().default(true),
  compressionThreshold: z.number().int().positive(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ModelModule = z.infer<typeof ModelModuleSchema>;

export const InstructionModuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  base: z.array(z.string()).default([]),
  runtimePatchable: z.boolean().default(false),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type InstructionModule = z.infer<typeof InstructionModuleSchema>;

export const ToolkitModuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  tools: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ToolkitModule = z.infer<typeof ToolkitModuleSchema>;

export const ConstraintsModuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  rules: z.array(z.string()).default([]),
  disallowedActions: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ConstraintsModule = z.infer<typeof ConstraintsModuleSchema>;

export const CapabilitiesModuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  skills: z.array(z.string()).default([]),
  functionSchemas: z.array(z.record(z.string(), z.unknown())).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CapabilitiesModule = z.infer<typeof CapabilitiesModuleSchema>;

// ==========================================
// RUNTIME CONTRACTS
// ==========================================

export const AgentStatusSchema = z.enum([
  "active",
  "idle",
  "thinking",
  "delegating",
  "executing",
  "sleeping",
  "working",
  "paused",
  "offline",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentRuntimeStateSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  status: AgentStatusSchema,
  activeTask: z.string().optional().nullable(),
  activeChannelId: z.string().optional().nullable(),
  startedAt: z.string().optional().nullable(),
  overridesApplied: z.array(z.string()).default([]),
  errorInfo: z
    .object({
      code: z.string(),
      message: z.string(),
      timestamp: z.string(),
    })
    .optional()
    .nullable(),
  lastHeartbeat: z.string().optional().nullable(),
  createdAt: z.string().optional(),
});
export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;

export const SwarmStateSchema = z.object({
  swarmId: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "terminated"]),
  members: z.array(z.string()),
  activeTasksCount: z.number(),
  createdAt: z.string(),
});
export type SwarmState = z.infer<typeof SwarmStateSchema>;

export const ConspiracyStateSchema = z.object({
  conspiracyId: z.string(),
  topic: z.string(),
  members: z.array(z.string()),
  consensusReached: z.boolean(),
  createdAt: z.string(),
});
export type ConspiracyState = z.infer<typeof ConspiracyStateSchema>;

export const WorkspacePermissionsSchema = z.object({
  network: z.boolean().default(false),
  shell: z.boolean().default(false),
  maxAgents: z.number().int().positive().default(8),
});
export type WorkspacePermissions = z.infer<typeof WorkspacePermissionsSchema>;

export const RuntimeConstraintsSchema = z.object({
  networkAccess: z.boolean().default(false),
  shellExecution: z.boolean().default(true),
  memoryLimitMb: z.number().int().positive().default(512),
  cpuLimit: z.number().positive().default(1),
});
export type RuntimeConstraints = z.infer<typeof RuntimeConstraintsSchema>;

export const WorkspaceRuntimeStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  status: z.enum(["CREATED", "INITIALIZING", "ACTIVE", "PAUSED", "TERMINATED", "ARCHIVED"]),
  rootPath: z.string(),
  permissions: WorkspacePermissionsSchema,
  constraints: RuntimeConstraintsSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceRuntimeState = z.infer<typeof WorkspaceRuntimeStateSchema>;

export const SandboxStateSchema = z.object({
  sandboxId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["idle", "busy", "crashed"]),
  activeProcesses: z.array(
    z.object({
      pid: z.number(),
      command: z.string(),
      startedAt: z.string(),
    })
  ),
  memoryUsedMb: z.number(),
  cpuUsagePercent: z.number(),
  lastUpdated: z.string(),
});
export type SandboxState = z.infer<typeof SandboxStateSchema>;

// ==========================================
// EVENT SCHEMAS
// ==========================================

export const AgentSpawnedEventSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  level: z.number(),
  workspaceId: z.string(),
  timestamp: z.string(),
});
export type AgentSpawnedEvent = z.infer<typeof AgentSpawnedEventSchema>;

export const AgentLifecycleEventSchema = z.object({
  agentId: z.string(),
  action: z.enum(["spawn", "pause", "resume", "terminate", "recover", "handoff", "delegate"]),
  workspaceId: z.string(),
  timestamp: z.string(),
});
export type AgentLifecycleEvent = z.infer<typeof AgentLifecycleEventSchema>;

export const EscalationEventSchema = z.object({
  id: z.string(),
  type: z.enum(["warning", "loop_detected", "soft_cap_approaching", "budget_exceeded", "parliament_escalation"]),
  agentId: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
});
export type EscalationEvent = z.infer<typeof EscalationEventSchema>;

export const SandboxUpdatedEventSchema = z.object({
  sandboxId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  timestamp: z.string(),
});
export type SandboxUpdatedEvent = z.infer<typeof SandboxUpdatedEventSchema>;

export const WorkspacePatchedEventSchema = z.object({
  workspaceId: z.string(),
  patch: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
});
export type WorkspacePatchedEvent = z.infer<typeof WorkspacePatchedEventSchema>;

export const RuntimeSnapshotEventSchema = z.object({
  workspaces: z.array(WorkspaceRuntimeStateSchema),
  agents: z.array(z.any()), // Allow loose agent schema since it evolves
  swarms: z.array(SwarmStateSchema),
  escalations: z.array(EscalationEventSchema),
  sandboxes: z.array(SandboxStateSchema),
  overrides: z.array(z.any()),
  runtimeHealth: z.object({
    status: z.enum(["healthy", "warning", "error"]),
    timestamp: z.string(),
  }),
});
export type RuntimeSnapshotEvent = z.infer<typeof RuntimeSnapshotEventSchema>;

export { stripToolCalls, parseToolCalls } from './text-utils.js';
export type { ParsedToolCall } from './text-utils.js';
