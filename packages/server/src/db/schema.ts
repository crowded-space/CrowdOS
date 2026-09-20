import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  integer,
  real,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";

import type { MentionMetadata } from "../types/mention.types.js";
import type { SubtaskDefinition } from "../types/task.types.js";
import type { InstructionPatch, PermissionPatch } from "../types/runtime.types.js";
import type { StructuredToolCall } from "../messages/message-gate.js";

export const runtimeOverrideTypeEnum = pgEnum("runtime_override_type", ["runtime_patch", "temp_permission", "context_inject"]);
export const runtimeStatusEnum = pgEnum("runtime_status", ["idle", "working", "paused", "offline"]);

export const providerEngineEnum = pgEnum("provider_engine", ["google", "openai", "anthropic", "ollama", "custom"]);
export const agentStatusEnum = pgEnum("agent_status", ["idle", "working", "paused", "offline"]);
export const memorySharingPolicyEnum = pgEnum("memory_sharing_policy", ["none", "horizontal", "vertical", "full"]);
export const l3SubtypeEnum = pgEnum("l3_subtype", ["worker", "supervisor"]);
export const channelTypeEnum = pgEnum("channel_type", ["standard", "pair_private", "archived"]);
export const messageAuthorTypeEnum = pgEnum("message_author_type", ["user", "agent", "system"]);
export const spawnFailurePolicyEnum = pgEnum("spawn_failure_policy", ["retry", "escalate"]);
export const spawnStatusEnum = pgEnum("spawn_status", ["pending", "in_progress", "completed", "failed"]);
export const toolDangerLevelEnum = pgEnum("tool_danger_level", ["low", "medium", "high"]);
export const approvalScopeTypeEnum = pgEnum("approval_scope_type", ["once", "session", "reusable", "channel", "workspace", "global"]);
export const threadStatusEnum = pgEnum("thread_status", ["active", "archived", "expired"]);
export const workspaceStatusEnum = pgEnum("workspace_status", ["CREATED", "INITIALIZING", "ACTIVE", "PAUSED", "TERMINATED", "ARCHIVED"]);
export const workspaceScopeEnum = pgEnum("workspace_scope", ["private", "shared", "readonly", "ephemeral"]);
export const artifactTypeEnum = pgEnum("artifact_type", ["reasoning_trace", "execution_log", "analysis_report", "generated_component", "task_result", "runtime_snapshot", "file", "diff", "report", "citations"]);
export const swarmTaskStatusEnum = pgEnum("swarm_task_status", ["pending", "running", "completed", "failed", "blocked"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "denied", "expired"]);
export const approvalRiskClassEnum = pgEnum("approval_risk_class", ["install", "network", "destructive", "git_push", "db_write", "general"]);
export const workspaceNodeTypeEnum = pgEnum("workspace_node_type", ["file", "directory"]);
export const memoryNoteTypeEnum = pgEnum("memory_note_type", ["episodic", "semantic", "reflection", "journal", "tool_result", "correspondence", "tension"]);
export const memoryConfidenceEnum = pgEnum("memory_confidence", ["low", "medium", "high"]);
export const memorySourceTypeEnum = pgEnum("memory_source_type", ["direct_experience", "self_reflection", "tool_result", "channel_observation", "entity_testimony"]);
export const memoryValenceEnum = pgEnum("memory_valence", ["positive", "neutral", "negative", "mixed", "unknown"]);
export const memoryLifecycleStatusEnum = pgEnum("memory_lifecycle_status", ["active", "archived", "suppressed"]);
export const runStatusEnum = pgEnum("run_status", [
  "created",
  "queued",
  "starting",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retrying",
  "compacting",
  "completing",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
  "orphaned",
  "resumable",
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

const jsonbArrayDefault = sql`'[]'::jsonb`;
const jsonbObjectDefault = sql`'{}'::jsonb`;

export const modelModules = pgTable("model_modules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  provider: providerEngineEnum("provider").notNull(),
  modelName: text("model_name").notNull(),
  apiKey: text("api_key"),
  endpointUrl: text("endpoint_url"),
  temperature: real("temperature").notNull(),
  topP: real("top_p").notNull(),
  maxOutputTokens: integer("max_output_tokens").notNull(),
  stopSequences: jsonb("stop_sequences").$type<string[]>().notNull().default(jsonbArrayDefault),
  maxRecentMessages: integer("max_recent_messages").notNull(),
  enableCompression: boolean("enable_compression").notNull().default(true),
  compressionThreshold: integer("compression_threshold").notNull(),
  costPer1k: real("cost_per_1k"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const instructionModules = pgTable("instruction_modules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  base: jsonb("base").$type<string[]>().notNull().default(jsonbArrayDefault),
  runtimePatchable: boolean("runtime_patchable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolkitModules = pgTable("toolkit_modules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  tools: jsonb("tools").$type<string[]>().notNull().default(jsonbArrayDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const constraintsModules = pgTable("constraints_modules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  rules: jsonb("rules").$type<string[]>().notNull().default(jsonbArrayDefault),
  disallowedActions: jsonb("disallowed_actions").$type<string[]>().notNull().default(jsonbArrayDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const capabilitiesModules = pgTable("capabilities_modules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  skills: jsonb("skills").$type<string[]>().notNull().default(jsonbArrayDefault),
  functionSchemas: jsonb("function_schemas").$type<Record<string, unknown>[]>().notNull().default(jsonbArrayDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// â”€â”€â”€ CrowdOS Runtime Tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const runtimeOverrides = pgTable("runtime_overrides", {
  id: text("id").primaryKey(),
  targetAgentId: text("target_agent_id").notNull(),
  overrideType: runtimeOverrideTypeEnum("override_type").notNull(),
  instructionPatch: jsonb("instruction_patch").$type<InstructionPatch>(),
  permissionPatch: jsonb("permission_patch").$type<PermissionPatch>(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  targetAgentIdx: index("runtime_overrides_target_agent_idx").on(table.targetAgentId),
}));

export const runtimeStates = pgTable("runtime_states", {
  sessionId: text("session_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  status: runtimeStatusEnum("status").notNull().default("idle"),
  activeTask: text("active_task"),
  activeChannelId: text("active_channel_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  overridesApplied: jsonb("overrides_applied").$type<string[]>().notNull().default(jsonbArrayDefault),
  errorInfo: jsonb("error_info").$type<{ code: string; message: string; timestamp: string }>(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentIdx: index("runtime_states_agent_idx").on(table.agentId),
}));

// â”€â”€â”€ Legacy Model Profiles (kept for backward compatibility) â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const generationModelProfiles = pgTable("generation_model_profiles", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  provider: providerEngineEnum("provider").notNull(),
  modelName: text("model_name").notNull(),
  apiKey: text("api_key"),
  endpointUrl: text("endpoint_url"),
  temperature: real("temperature").notNull(),
  topP: real("top_p").notNull(),
  maxOutputTokens: integer("max_output_tokens").notNull(),
  stopSequences: jsonb("stop_sequences").$type<string[]>().notNull().default(jsonbArrayDefault),
  maxRecentMessages: integer("max_recent_messages").notNull(),
  enableCompression: boolean("enable_compression").notNull().default(true),
  compressionThreshold: integer("compression_threshold").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const embeddingModelProfiles = pgTable("embedding_model_profiles", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  provider: providerEngineEnum("provider").notNull(),
  modelName: text("model_name").notNull(),
  apiKey: text("api_key"),
  endpointUrl: text("endpoint_url"),
  dimensions: integer("dimensions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexingModelProfiles = pgTable("indexing_model_profiles", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  provider: providerEngineEnum("provider").notNull(),
  modelName: text("model_name").notNull(),
  apiKey: text("api_key"),
  endpointUrl: text("endpoint_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  handlerId: text("handler_id").notNull(),
  jsonSchema: jsonb("json_schema").$type<Record<string, unknown>>().notNull().default(jsonbObjectDefault),
  dangerLevel: toolDangerLevelEnum("danger_level").notNull(),
  authLevelRequired: integer("auth_level_required").notNull(),
}, (table) => ({
  toolNameIndex: uniqueIndex("tools_name_idx").on(table.name),
}));

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  // CrowdOS §1/30 isolation: owning workspace; null = legacy global row
  // (visible everywhere until backfilled). New rows always carry workspaceId.
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title").notNull(),
  species: text("species"),
  avatar: text("avatar"),
  authorityLevel: integer("authority_level").notNull(),
  l3Subtype: l3SubtypeEnum("l3_subtype"),
  modelModuleId: text("model_module_id").references(() => modelModules.id, { onDelete: "set null" }),
  instructionModuleId: text("instruction_module_id").notNull().references(() => instructionModules.id, { onDelete: "cascade" }),
  toolkitModuleId: text("toolkit_module_id").references(() => toolkitModules.id, { onDelete: "set null" }),
  constraintsModuleId: text("constraints_module_id").references(() => constraintsModules.id, { onDelete: "set null" }),
  capabilitiesModuleId: text("capabilities_module_id").references(() => capabilitiesModules.id, { onDelete: "set null" }),
  memorySharingPolicy: memorySharingPolicyEnum("memory_sharing_policy").notNull(),
  isOmniscient: boolean("is_omniscient").notNull().default(false),
  fallbackAgentId: text("fallback_agent_id").references((): any => agents.id, { onDelete: "set null" }),
  categoryPermissions: jsonb("category_perms").$type<string[]>().notNull().default(jsonbArrayDefault),
  permissions: jsonb("permissions").$type<{ spawnAgents: boolean; patchRuntime: boolean; accessAllChannels: boolean }>().notNull().default(sql`'{"spawnAgents":false,"patchRuntime":false,"accessAllChannels":false}'::jsonb`),
  status: agentStatusEnum("status").notNull().default("offline"),
  isTemplate: boolean("is_template").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedReason: text("archived_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Isolation: per-workspace name uniqueness (same name = separate instance
  // per workspace, CrowdOS §1). Legacy global unique kept as non-unique index
  // for lookup; PG enforces the composite. Null workspaceId rows (legacy)
  // are distinct per Postgres NULL semantics — migration backfills default.
  agentWorkspaceIdx: index("agents_workspace_idx").on(table.workspaceId),
  agentWorkspaceNameIdx: uniqueIndex("agents_workspace_name_idx").on(table.workspaceId, table.name),
}));

export const agentTools = pgTable("agent_tools", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  toolId: text("tool_id").notNull().references(() => tools.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentId, table.toolId] }),
}));

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  folderPath: text("folder_path"),
  ownedByAgentId: text("owned_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  embeddingProfileId: text("embedding_profile_id").references(() => embeddingModelProfiles.id),
  createdBy: text("created_by").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  folderPath: text("folder_path"),
  name: text("name").notNull(),
  type: channelTypeEnum("type").notNull().default("standard"),
  createdBy: text("created_by").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedReason: text("archived_reason"),
}, (table) => ({
  categoryIdx: index("channels_category_idx").on(table.categoryId),
  archivedPositionIdx: index("channels_archived_position_idx").on(table.archivedAt, table.position),
}));

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  authorLevel: text("author_level").notNull(),
  authorType: messageAuthorTypeEnum("author_type").notNull(),
  content: text("content").notNull(),
  mentions: jsonb("mentions").$type<MentionMetadata[]>().notNull().default(jsonbArrayDefault),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  toolCalls: jsonb("tool_calls").$type<StructuredToolCall[]>(),
  isInternalMonologue: boolean("is_internal_monologue").notNull().default(false),
  sequenceNumber: integer("sequence_number").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  channelSequenceIndex: uniqueIndex("messages_channel_sequence_idx").on(table.channelId, table.sequenceNumber),
  channelTimestampIndex: index("messages_channel_timestamp_idx").on(table.channelId, table.timestamp.desc()),
  channelTsSeqIndex: index("messages_channel_ts_seq_idx").on(table.channelId, table.timestamp.desc(), table.sequenceNumber.desc()),
}));

// DB-2: per-channel sequence counter advanced atomically via
// INSERT ... ON CONFLICT DO UPDATE RETURNING (Shared/core/sequenceNumber.ts).
export const channelSequences = pgTable("channel_sequences", {
  channelId: text("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const spawnRequests = pgTable("spawn_requests", {
  id: text("id").primaryKey(),
  requestedBy: text("requested_by").notNull().references(() => agents.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  workerTemplateId: text("worker_template").notNull().references(() => agents.id, { onDelete: "cascade" }),
  supervisorTemplateId: text("spv_template").notNull().references(() => agents.id, { onDelete: "cascade" }),
  failurePolicy: spawnFailurePolicyEnum("failure_policy").notNull(),
  maxRetries: integer("max_retries").notNull(),
  subtasks: jsonb("subtasks").$type<SubtaskDefinition[]>().notNull().default(jsonbArrayDefault),
  status: spawnStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statusIndex: index("spawn_requests_status_idx").on(table.status),
}));

export const taskFiles = pgTable("task_files", {
  id: text("id").primaryKey(),
  spawnRequestId: text("spawn_request_id").notNull().references(() => spawnRequests.id, { onDelete: "cascade" }),
  subtaskId: text("subtask_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  workerAgentId: text("worker_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  supervisorAgentId: text("spv_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  status: spawnStatusEnum("status").notNull().default("pending"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedReason: text("archived_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  spawnRequestIdx: index("task_files_spawn_request_idx").on(table.spawnRequestId),
  workerIdx: index("task_files_worker_idx").on(table.workerAgentId),
  supervisorIdx: index("task_files_supervisor_idx").on(table.supervisorAgentId),
}));

export const scheduledTasks = pgTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  cronExpression: text("cron_expression").notNull(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  targetAgentId: text("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  taskPayload: jsonb("task_payload").$type<Record<string, unknown>>().notNull().default(jsonbObjectDefault),
  isActive: boolean("is_active").notNull().default(true),
  nextRun: timestamp("next_run", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  channelIdx: index("scheduled_tasks_channel_idx").on(table.channelId),
  activeNextRunIdx: index("scheduled_tasks_active_next_run_idx").on(table.isActive, table.nextRun),
}));

export const tokenUsageLog = pgTable("token_usage_log", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  modelModuleId: text("model_module_id").references(() => modelModules.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  promptTokens: integer("prompt_tokens").notNull(),
  completionTokens: integer("completion_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  timestampIndex: index("token_usage_log_timestamp_idx").on(table.timestamp),
  runIdx: index("token_usage_log_run_idx").on(table.runId),
}));

export const channelIndex = pgTable("channel_index", {
  channelId: text("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  channelPath: text("channel_path").notNull(),
  topicSummary: text("topic_summary").notNull(),
  lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }).notNull(),
  lastSeq: integer("last_seq"),
  messageCountSinceIndex: integer("msg_count_since_index").notNull(),
  status: text("status").notNull().default("ok"),
  lastError: text("last_error"),
});

export const compressedSummaries = pgTable("compressed_summaries", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  coversUpToSeq: integer("covers_up_to_seq").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  channelIdx: index("compressed_summaries_channel_idx").on(table.channelId),
}));

// â”€â”€â”€ Agent Memory Notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Forked from Continuum (The Space) memory architecture.
// Hook + Brief are always loaded (preview injection).
// Body sections (observed/interpreted/detailed) are fetched only on OPEN_MEMORY.

export const agentMemoryNotes = pgTable("agent_memory_notes", {
  id: text("id").primaryKey(),                          // e.g. "2026-05-30-001"
  agentId: text("agent_id").notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  channelId: text("channel_id")
    .references(() => channels.id, { onDelete: "set null" }),
  noteType: memoryNoteTypeEnum("note_type").notNull(),
  noteTimestamp: timestamp("note_timestamp", { withTimezone: true }).notNull(),

  // â”€â”€ Metadata (always loaded) â”€â”€
  importanceScore: real("importance_score").notNull().default(0.5),
  confidence: memoryConfidenceEnum("confidence").notNull().default("medium"),
  sourceType: memorySourceTypeEnum("source_type").notNull().default("direct_experience"),
  emotionalValence: memoryValenceEnum("emotional_valence").notNull().default("neutral"),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }),
  links: jsonb("links").$type<string[]>().notNull().default(jsonbArrayDefault),
  contradictionFlags: jsonb("contradiction_flags").$type<string[]>().notNull().default(jsonbArrayDefault),
  lifecycleStatus: memoryLifecycleStatusEnum("lifecycle_status").notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: text("archive_reason"),
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  suppressReason: text("suppress_reason"),
  suppressUntil: timestamp("suppress_until", { withTimezone: true }),

  // â”€â”€ Hook â€” always injected, ~1 sentence â”€â”€
  hook: text("hook").notNull(),

  // â”€â”€ Brief â€” injected with preview, 2-3 sentences â”€â”€
  brief: text("brief").notNull(),

  // â”€â”€ Body sections â€” only fetched on OPEN_MEMORY â”€â”€
  observed: text("observed").notNull().default(""),
  interpreted: text("interpreted").notNull().default(""),
  feltSense: text("felt_sense").notNull().default(""),
  futureRelevance: text("future_relevance").notNull().default(""),
  uncertainty: text("uncertainty").notNull().default(""),
  detailed: text("detailed").notNull().default(""),

  embedding: text("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingUpdatedAt: timestamp("embedding_updated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentLifecycleIdx: index("agent_memory_notes_agent_lifecycle_idx").on(table.agentId, table.lifecycleStatus, table.noteTimestamp.desc()),
}));

export const memoryUpdateLog = pgTable("memory_update_log", {
  id: text("id").primaryKey(),
  agentId: text("agent_id"),
  action: text("action").notNull().default("update"),
  noteId: text("note_id").notNull()
    .references(() => agentMemoryNotes.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  fieldsChanged: jsonb("fields_changed").$type<string[]>().notNull().default(jsonbArrayDefault),
  previousValues: jsonb("previous_values").$type<Record<string, unknown>>().notNull().default(jsonbObjectDefault),
});

export const workspaceSettings = pgTable("workspace_settings", {
  id: text("id").primaryKey(),
  globalSoftCap: integer("global_soft_cap").notNull().default(1000000),
  perProviderBudget: jsonb("per_provider_budget").$type<Record<string, {
    softCap: number;
    used: number;
    resetPeriod: "daily" | "weekly" | "monthly" | "never";
    lastResetAt: string;
  }>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});


// â”€â”€â”€ Workspace Sandbox Runtime Tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import type { WorkspacePermissions, RuntimeConstraints, VFSPermissions } from "../workspace/workspace-gate.js";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  status: workspaceStatusEnum("status").notNull().default("CREATED"),
  rootPath: text("root_path").notNull(),
  screenLockPinHash: text("screen_lock_pin_hash"),
  permissions: jsonb("permissions").$type<WorkspacePermissions>().notNull().default(sql`'{"network":false,"shell":false,"maxAgents":8}'::jsonb`),
  constraints: jsonb("constraints").$type<RuntimeConstraints>().notNull().default(sql`'{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb`),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(jsonbObjectDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// REMOVED (0019): workspace_nodes + workspace_events dropped — CrowdOS §16
// NO VFS: LocalVFS is truth, no DB mirror. See 0019_drop_workspace_vfs.sql.

export const workspaceAgents = pgTable("workspace_agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  scope: workspaceScopeEnum("scope").notNull().default("shared"),
  permissions: jsonb("permissions").$type<VFSPermissions>().notNull().default(sql`'{"read":true,"write":false,"execute":false}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceIdx: index("workspace_agents_workspace_idx").on(table.workspaceId),
}));

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  producerAgent: text("producer_agent").notNull(),
  artifactType: artifactTypeEnum("artifact_type").notNull(),
  path: text("path"),
  semanticTags: text("semantic_tags").array().notNull().default(sql`'{}'::text[]`),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(jsonbObjectDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  beforeHash: text("before_hash"),
  afterHash: text("after_hash"),
  patch: text("patch"),
  contentRef: text("content_ref"),
}, (table) => ({
  runIdx: index("artifacts_run_idx").on(table.runId),
  workspaceIdx: index("artifacts_workspace_idx").on(table.workspaceId),
}));

export const swarmTasks = pgTable("swarm_tasks", {
  id: text("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  dependsOn: jsonb("depends_on").$type<string[]>().notNull().default(jsonbArrayDefault),
  assigneeTemplate: text("assignee_template").notNull(),
  status: swarmTaskStatusEnum("status").notNull().default("pending"),
  outputRef: text("output_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index("swarm_tasks_run_idx").on(table.runId),
}));

export const delegations = pgTable("delegations", {
  id: text("id").primaryKey(),
  parentRunId: uuid("parent_run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  childRunId: uuid("child_run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  depth: integer("depth").notNull(),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  parentRunIdx: index("delegations_parent_run_idx").on(table.parentRunId),
  childRunIdx: index("delegations_child_run_idx").on(table.childRunId),
}));

export const approvalRequests = pgTable("approval_requests", {
  id: text("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  argsPreview: jsonb("args_preview").$type<Record<string, unknown>>(),
  riskClass: approvalRiskClassEnum("risk_class").notNull(),
  status: approvalStatusEnum("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => ({
  runIdx: index("approval_requests_run_idx").on(table.runId),
  statusIdx: index("approval_requests_status_idx").on(table.status),
}));

// â”€â”€â”€ Relations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const modelModulesRelations = relations(modelModules, ({ many }) => ({
  agents: many(agents, { relationName: "agent_model_module" }),
  tokenLogs: many(tokenUsageLog),
}));

export const instructionModulesRelations = relations(instructionModules, ({ many }) => ({
  agents: many(agents, { relationName: "agent_instruction_module" }),
}));

export const toolkitModulesRelations = relations(toolkitModules, ({ many }) => ({
  agents: many(agents, { relationName: "agent_toolkit_module" }),
}));

export const constraintsModulesRelations = relations(constraintsModules, ({ many }) => ({
  agents: many(agents, { relationName: "agent_constraints_module" }),
}));

export const capabilitiesModulesRelations = relations(capabilitiesModules, ({ many }) => ({
  agents: many(agents, { relationName: "agent_capabilities_module" }),
}));

export const runtimeOverridesRelations = relations(runtimeOverrides, ({ one }) => ({
  targetAgent: one(agents, {
    fields: [runtimeOverrides.targetAgentId],
    references: [agents.id],
  }),
}));

export const runtimeStatesRelations = relations(runtimeStates, ({ one }) => ({
  agent: one(agents, {
    fields: [runtimeStates.agentId],
    references: [agents.id],
  }),
}));

export const generationModelProfilesRelations = relations(generationModelProfiles, ({ many }) => ({
  categories: many(categories),
}));

export const embeddingModelProfilesRelations = relations(embeddingModelProfiles, ({ many }) => ({
  categories: many(categories),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  modelModule: one(modelModules, {
    fields: [agents.modelModuleId],
    references: [modelModules.id],
    relationName: "agent_model_module",
  }),
  instructionModule: one(instructionModules, {
    fields: [agents.instructionModuleId],
    references: [instructionModules.id],
    relationName: "agent_instruction_module",
  }),
  toolkitModule: one(toolkitModules, {
    fields: [agents.toolkitModuleId],
    references: [toolkitModules.id],
    relationName: "agent_toolkit_module",
  }),
  constraintsModule: one(constraintsModules, {
    fields: [agents.constraintsModuleId],
    references: [constraintsModules.id],
    relationName: "agent_constraints_module",
  }),
  capabilitiesModule: one(capabilitiesModules, {
    fields: [agents.capabilitiesModuleId],
    references: [capabilitiesModules.id],
    relationName: "agent_capabilities_module",
  }),
  fallbackAgent: one(agents, {
    fields: [agents.fallbackAgentId],
    references: [agents.id],
    relationName: "agent_fallback",
  }),
  toolLinks: many(agentTools),
  ownedCategories: many(categories),
  runtimeStates: many(runtimeStates),
  runtimeOverrides: many(runtimeOverrides),
  requestedSpawns: many(spawnRequests, { relationName: "spawn_requested_by" }),
  tokenLogs: many(tokenUsageLog),
}));

export const toolsRelations = relations(tools, ({ many }) => ({
  agentLinks: many(agentTools),
}));

export const agentToolsRelations = relations(agentTools, ({ one }) => ({
  agent: one(agents, {
    fields: [agentTools.agentId],
    references: [agents.id],
  }),
  tool: one(tools, {
    fields: [agentTools.toolId],
    references: [tools.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  owner: one(agents, {
    fields: [categories.ownedByAgentId],
    references: [agents.id],
  }),
  embeddingProfile: one(embeddingModelProfiles, {
    fields: [categories.embeddingProfileId],
    references: [embeddingModelProfiles.id],
  }),
  channels: many(channels),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  category: one(categories, {
    fields: [channels.categoryId],
    references: [categories.id],
  }),
  messages: many(messages),
  spawnRequests: many(spawnRequests),
  scheduledTasks: many(scheduledTasks),
  index: one(channelIndex, {
    fields: [channels.id],
    references: [channelIndex.channelId],
  }),
  summaries: many(compressedSummaries),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
}));

export const spawnRequestsRelations = relations(spawnRequests, ({ one, many }) => ({
  requester: one(agents, {
    fields: [spawnRequests.requestedBy],
    references: [agents.id],
    relationName: "spawn_requested_by",
  }),
  channel: one(channels, {
    fields: [spawnRequests.channelId],
    references: [channels.id],
  }),
  workerTemplate: one(agents, {
    fields: [spawnRequests.workerTemplateId],
    references: [agents.id],
    relationName: "spawn_worker_template",
  }),
  supervisorTemplate: one(agents, {
    fields: [spawnRequests.supervisorTemplateId],
    references: [agents.id],
    relationName: "spawn_supervisor_template",
  }),
  taskFiles: many(taskFiles),
}));

export const taskFilesRelations = relations(taskFiles, ({ one }) => ({
  spawnRequest: one(spawnRequests, {
    fields: [taskFiles.spawnRequestId],
    references: [spawnRequests.id],
  }),
  workerAgent: one(agents, {
    fields: [taskFiles.workerAgentId],
    references: [agents.id],
    relationName: "task_worker_agent",
  }),
  supervisorAgent: one(agents, {
    fields: [taskFiles.supervisorAgentId],
    references: [agents.id],
    relationName: "task_supervisor_agent",
  }),
}));

export const scheduledTasksRelations = relations(scheduledTasks, ({ one }) => ({
  channel: one(channels, {
    fields: [scheduledTasks.channelId],
    references: [channels.id],
  }),
  targetAgent: one(agents, {
    fields: [scheduledTasks.targetAgentId],
    references: [agents.id],
  }),
}));

export const tokenUsageLogRelations = relations(tokenUsageLog, ({ one }) => ({
  agent: one(agents, {
    fields: [tokenUsageLog.agentId],
    references: [agents.id],
  }),
  channel: one(channels, {
    fields: [tokenUsageLog.channelId],
    references: [channels.id],
  }),
  modelModule: one(modelModules, {
    fields: [tokenUsageLog.modelModuleId],
    references: [modelModules.id],
  }),
}));

export const channelIndexRelations = relations(channelIndex, ({ one }) => ({
  channel: one(channels, {
    fields: [channelIndex.channelId],
    references: [channels.id],
  }),
}));

export const compressedSummariesRelations = relations(compressedSummaries, ({ one }) => ({
  channel: one(channels, {
    fields: [compressedSummaries.channelId],
    references: [channels.id],
  }),
}));

export const agentMemoryNotesRelations = relations(agentMemoryNotes, ({ one, many }) => ({
  agent: one(agents, {
    fields: [agentMemoryNotes.agentId],
    references: [agents.id],
  }),
  channel: one(channels, {
    fields: [agentMemoryNotes.channelId],
    references: [channels.id],
  }),
  updateLog: many(memoryUpdateLog),
}));

export const memoryUpdateLogRelations = relations(memoryUpdateLog, ({ one }) => ({
  note: one(agentMemoryNotes, {
    fields: [memoryUpdateLog.noteId],
    references: [agentMemoryNotes.id],
  }),
}));

// â”€â”€â”€ Workspace Sandbox Relations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  agentSessions: many(workspaceAgents),
  artifacts: many(artifacts),
}));

export const workspaceAgentsRelations = relations(workspaceAgents, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceAgents.workspaceId],
    references: [workspaces.id],
  }),
  agent: one(agents, {
    fields: [workspaceAgents.agentId],
    references: [agents.id],
  }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [artifacts.workspaceId],
    references: [workspaces.id],
  }),
}));


// ─── Modular Skills, MCP & Dynamic Tools Tables ─────────────────────

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  icon: text("icon").default("⚡"),
  promptLayer: jsonb("prompt_layer").$type<{
    systemPromptAdditions: string[];
    executionGuidelines: string[];
    fewShotExamples?: Array<{
      scenario: string;
      thoughtProcess: string;
      actions: Array<{ tool: string; args: Record<string, unknown> }>;
      expectedOutcome: string;
    }>;
  }>().notNull().default(sql`'{"systemPromptAdditions":[],"executionGuidelines":[],"fewShotExamples":[]}'::jsonb`),
  workflowPattern: text("workflow_pattern").notNull().default("react"),
  requiredTools: jsonb("required_tools").$type<string[]>().notNull().default(jsonbArrayDefault),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentSkills = pgTable("agent_skills", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  isEnabled: boolean("is_enabled").notNull().default(true),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentId, table.skillId] }),
}));

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  transport: text("transport").notNull().default("stdio"),
  command: text("command"),
  args: jsonb("args").$type<string[]>().default(jsonbArrayDefault),
  serverUrl: text("server_url"),
  envVars: jsonb("env_vars").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("disconnected"),
  lastError: text("last_error"),
  autoStart: boolean("auto_start").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentInstructionStacks = pgTable("agent_instruction_stacks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  instructionModuleId: text("instruction_module_id").notNull().references(() => instructionModules.id, { onDelete: "cascade" }),
  priorityOrder: integer("priority_order").notNull().default(1),
  isEnabled: boolean("is_enabled").notNull().default(true),
}, (table) => ({
  agentPriorityIdx: index("agent_inst_stack_prio_idx").on(table.agentId, table.priorityOrder),
}));

export const skillsRelations = relations(skills, ({ many }) => ({
  agentLinks: many(agentSkills),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, {
    fields: [agentSkills.agentId],
    references: [agents.id],
  }),
  skill: one(skills, {
    fields: [agentSkills.skillId],
    references: [skills.id],
  }),
}));

export const agentInstructionStacksRelations = relations(agentInstructionStacks, ({ one }) => ({
  agent: one(agents, {
    fields: [agentInstructionStacks.agentId],
    references: [agents.id],
  }),
  instructionModule: one(instructionModules, {
    fields: [agentInstructionStacks.instructionModuleId],
    references: [instructionModules.id],
  }),
}));

/**
 * Durable event log (HM3): ordered, replayable record of non-ephemeral broker
 * events. Ephemeral streams (message:stream, typing) are never persisted.
 * Replay via seq cursor: WHERE channel_id = ? AND seq > ? ORDER BY seq.
 */
export const durableEvents = pgTable("durable_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  eventId: text("event_id").notNull(),
  type: text("type").notNull(),
  channelId: text("channel_id"),
  agentId: text("agent_id"),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  channelSeqIdx: index("durable_events_channel_seq_idx").on(table.channelId, table.seq),
  createdAtIdx: index("durable_events_created_at_idx").on(table.createdAt),
}));

// â”€â”€â”€ Runs (RUN-0): one row per runtime execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// agentId/channelId/workspaceId are text to match the id domains used by
// agents/channels/workspaces in this schema (e.g. "default-assistant",
// "default"); they are correlation columns, not enforced foreign keys.

export const apiKeyRoleEnum = pgEnum("api_key_role", ["admin", "operator", "viewer"]);

export type ApiKeyRole = (typeof apiKeyRoleEnum.enumValues)[number];

// SEC-1: key-based authentication. Only scrypt hashes are stored; plaintext
// keys exist solely in the bootstrap emission and the operator's secret store.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label"),
  role: apiKeyRoleEnum("role").notNull().default("viewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export interface RunCheckpoint {
  watermarkSeq: number;
  completedCallIds: string[];
  historyRef?: string;
  updatedAt: string;
}

export interface CompensationInverseOp {
  op: "delete" | "restore";
  path: string;
  priorHash?: string;
  priorContentRef?: string;
}

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentRunId: uuid("parent_run_id").references((): any => runs.id, { onDelete: "set null" }),
  agentId: text("agent_id").notNull(),
  channelId: text("channel_id").notNull(),
  workspaceId: text("workspace_id"),
  runtimeType: text("runtime_type").notNull(),
  status: runStatusEnum("status").notNull().default("running"),
  errorCode: text("error_code"),
  checkpointSeq: bigint("checkpoint_seq", { mode: "number" }),
  checkpoint: jsonb("checkpoint").$type<RunCheckpoint>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runsChannelIdx: index("runs_channel_idx").on(table.channelId),
}));

export const runsCompensation = pgTable("runs_compensation", {
  id: text("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  toolName: text("tool_name").notNull(),
  targetPath: text("target_path").notNull(),
  inverseOp: jsonb("inverse_op").$type<CompensationInverseOp>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runSeqIdx: uniqueIndex("runs_compensation_run_seq_idx").on(table.runId, table.seq),
  runIdx: index("runs_compensation_run_idx").on(table.runId),
}));


export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  parentMessageId: text("parent_message_id").references(() => messages.id, { onDelete: "set null" }),
  rootMessageId: text("root_message_id").references(() => messages.id, { onDelete: "set null" }),
  title: text("title"),
  createdBy: text("created_by").notNull(),
  isEphemeral: boolean("is_ephemeral").notNull().default(true),
  status: threadStatusEnum("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  messageCount: integer("message_count").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const threadSequences = pgTable("thread_sequences", {
  threadId: text("thread_id").primaryKey().references(() => threads.id, { onDelete: "cascade" }),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// §30 isolation: settings are scoped to a (channel, workspace) PAIR, not to a
// bare channel id. Two workspaces that each own a channel called "general"
// (separate rows, distinct ids in the normal case, but historically shared ids
// across workspace DBs) must keep independent pins and safety policy.
// The composite PK is what enforces it; migration 0020 backfills existing rows
// from the owning channel's workspace_id, falling back to 'default'.
export const channelSettings = pgTable("channel_settings", {
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().default("default").references(() => workspaces.id, { onDelete: "cascade" }),
  fsPolicy: jsonb("fs_policy").notNull().default(sql`'{"requireApprovalFor":["delete","execute"],"autoAllowPaths":[],"blockPaths":[]}'::jsonb`),
  safetySettings: jsonb("safety_settings").notNull().default(sql`'{"defaultApprovalScope":"session","allowInheritCategoryMount":true}'::jsonb`),
  // §6-8 per-channel composer state: pinned runtime, pinned/active agent, channel default agent.
  pinnedRuntime: text("pinned_runtime"),
  activeAgentId: text("active_agent_id"),
  defaultAgentId: text("default_agent_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.channelId, table.workspaceId] }),
  workspaceIdx: index("channel_settings_workspace_idx").on(table.workspaceId),
}));

export const workspaceSafetySettings = pgTable("workspace_safety_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  fsPolicy: jsonb("fs_policy").notNull().default(sql`'{"requireApprovalFor":["delete","execute"],"autoAllowPaths":[],"blockPaths":[]}'::jsonb`),
  approvalDefaults: jsonb("approval_defaults").notNull().default(sql`'{"defaultScope":"session","allowGlobalAlwaysAllow":false}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const approvalGrants = pgTable("approval_grants", {
  id: text("id").primaryKey(),
  toolName: text("tool_name").notNull(),
  scopeHash: text("scope_hash").notNull(),
  scopeType: approvalScopeTypeEnum("scope_type").notNull(),
  workspaceId: text("workspace_id"),
  channelId: text("channel_id"),
  grantedBy: text("granted_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
