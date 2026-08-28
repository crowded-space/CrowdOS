CREATE TYPE "public"."agent_status" AS ENUM('idle', 'working', 'paused', 'offline');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('reasoning_trace', 'execution_log', 'analysis_report', 'generated_component', 'task_result', 'runtime_snapshot');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('standard', 'pair_private', 'archived');--> statement-breakpoint
CREATE TYPE "public"."l3_subtype" AS ENUM('worker', 'supervisor');--> statement-breakpoint
CREATE TYPE "public"."memory_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."memory_lifecycle_status" AS ENUM('active', 'archived', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."memory_note_type" AS ENUM('episodic', 'semantic', 'reflection', 'journal', 'tool_result', 'correspondence', 'tension');--> statement-breakpoint
CREATE TYPE "public"."memory_sharing_policy" AS ENUM('none', 'horizontal', 'vertical', 'full');--> statement-breakpoint
CREATE TYPE "public"."memory_source_type" AS ENUM('direct_experience', 'self_reflection', 'tool_result', 'channel_observation', 'entity_testimony');--> statement-breakpoint
CREATE TYPE "public"."memory_valence" AS ENUM('positive', 'neutral', 'negative', 'mixed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_author_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."provider_engine" AS ENUM('google', 'openai', 'anthropic', 'ollama', 'custom');--> statement-breakpoint
CREATE TYPE "public"."runtime_override_type" AS ENUM('runtime_patch', 'temp_permission', 'context_inject');--> statement-breakpoint
CREATE TYPE "public"."runtime_status" AS ENUM('idle', 'working', 'paused', 'offline');--> statement-breakpoint
CREATE TYPE "public"."spawn_failure_policy" AS ENUM('retry', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."spawn_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tool_danger_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."workspace_node_type" AS ENUM('file', 'directory');--> statement-breakpoint
CREATE TYPE "public"."workspace_scope" AS ENUM('private', 'shared', 'readonly', 'ephemeral');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('CREATED', 'INITIALIZING', 'ACTIVE', 'PAUSED', 'TERMINATED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "agent_instruction_stacks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"instruction_module_id" text NOT NULL,
	"priority_order" integer DEFAULT 1 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text,
	"note_type" "memory_note_type" NOT NULL,
	"note_timestamp" timestamp with time zone NOT NULL,
	"importance_score" real DEFAULT 0.5 NOT NULL,
	"confidence" "memory_confidence" DEFAULT 'medium' NOT NULL,
	"source_type" "memory_source_type" DEFAULT 'direct_experience' NOT NULL,
	"emotional_valence" "memory_valence" DEFAULT 'neutral' NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed" timestamp with time zone,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradiction_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifecycle_status" "memory_lifecycle_status" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	"suppressed_at" timestamp with time zone,
	"suppress_reason" text,
	"suppress_until" timestamp with time zone,
	"hook" text NOT NULL,
	"brief" text NOT NULL,
	"observed" text DEFAULT '' NOT NULL,
	"interpreted" text DEFAULT '' NOT NULL,
	"felt_sense" text DEFAULT '' NOT NULL,
	"future_relevance" text DEFAULT '' NOT NULL,
	"uncertainty" text DEFAULT '' NOT NULL,
	"detailed" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"species" text,
	"avatar" text,
	"authority_level" integer NOT NULL,
	"l3_subtype" "l3_subtype",
	"model_module_id" text NOT NULL,
	"instruction_module_id" text NOT NULL,
	"toolkit_module_id" text,
	"constraints_module_id" text,
	"capabilities_module_id" text,
	"memory_sharing_policy" "memory_sharing_policy" NOT NULL,
	"is_omniscient" boolean DEFAULT false NOT NULL,
	"fallback_agent_id" text,
	"category_perms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '{"spawnAgents":false,"patchRuntime":false,"accessAllChannels":false}'::jsonb NOT NULL,
	"status" "agent_status" DEFAULT 'offline' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"producer_agent" text NOT NULL,
	"artifact_type" "artifact_type" NOT NULL,
	"path" text,
	"semantic_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capabilities_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"function_schemas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owned_by_agent_id" text,
	"embedding_profile_id" text,
	"created_by" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_index" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"channel_path" text NOT NULL,
	"topic_summary" text NOT NULL,
	"last_indexed_at" timestamp with time zone NOT NULL,
	"msg_count_since_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text,
	"name" text NOT NULL,
	"type" "channel_type" DEFAULT 'standard' NOT NULL,
	"created_by" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compressed_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"summary" text NOT NULL,
	"covers_up_to_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "constraints_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disallowed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "durable_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"channel_id" text,
	"agent_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"provider" "provider_engine" NOT NULL,
	"model_name" text NOT NULL,
	"api_key" text,
	"endpoint_url" text,
	"dimensions" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"provider" "provider_engine" NOT NULL,
	"model_name" text NOT NULL,
	"api_key" text,
	"endpoint_url" text,
	"temperature" real NOT NULL,
	"top_p" real NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"stop_sequences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_recent_messages" integer NOT NULL,
	"enable_compression" boolean DEFAULT true NOT NULL,
	"compression_threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexing_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"provider" "provider_engine" NOT NULL,
	"model_name" text NOT NULL,
	"api_key" text,
	"endpoint_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruction_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"base" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runtime_patchable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb,
	"server_url" text,
	"env_vars" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_error" text,
	"auto_start" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_update_log" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"fields_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_values" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_level" text NOT NULL,
	"author_type" "message_author_type" NOT NULL,
	"content" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_internal_monologue" boolean DEFAULT false NOT NULL,
	"sequence_number" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"provider" "provider_engine" NOT NULL,
	"model_name" text NOT NULL,
	"api_key" text,
	"endpoint_url" text,
	"temperature" real NOT NULL,
	"top_p" real NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"stop_sequences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_recent_messages" integer NOT NULL,
	"enable_compression" boolean DEFAULT true NOT NULL,
	"compression_threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"target_agent_id" text NOT NULL,
	"override_type" "runtime_override_type" NOT NULL,
	"instruction_patch" jsonb,
	"permission_patch" jsonb,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_states" (
	"session_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" "runtime_status" DEFAULT 'idle' NOT NULL,
	"active_task" text,
	"active_channel_id" text,
	"started_at" timestamp with time zone,
	"overrides_applied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_info" jsonb,
	"last_heartbeat" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"cron_expression" text NOT NULL,
	"channel_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"task_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"next_run" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"icon" text DEFAULT '⚡',
	"prompt_layer" jsonb DEFAULT '{"systemPromptAdditions":[],"executionGuidelines":[],"fewShotExamples":[]}'::jsonb NOT NULL,
	"workflow_pattern" text DEFAULT 'react' NOT NULL,
	"required_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spawn_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"channel_id" text NOT NULL,
	"worker_template" text NOT NULL,
	"spv_template" text NOT NULL,
	"failure_policy" "spawn_failure_policy" NOT NULL,
	"max_retries" integer NOT NULL,
	"subtasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "spawn_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_files" (
	"id" text PRIMARY KEY NOT NULL,
	"spawn_request_id" text NOT NULL,
	"subtask_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"worker_agent_id" text NOT NULL,
	"spv_agent_id" text NOT NULL,
	"status" "spawn_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"model_module_id" text,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "toolkit_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"handler_id" text NOT NULL,
	"json_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"danger_level" "tool_danger_level" NOT NULL,
	"auth_level_required" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"scope" "workspace_scope" DEFAULT 'shared' NOT NULL,
	"permissions" jsonb DEFAULT '{"read":true,"write":false,"execute":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"agent_id" text,
	"path" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"type" "workspace_node_type" NOT NULL,
	"mime_type" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"checksum" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"global_soft_cap" integer DEFAULT 1000000 NOT NULL,
	"per_provider_budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" "workspace_status" DEFAULT 'CREATED' NOT NULL,
	"root_path" text NOT NULL,
	"permissions" jsonb DEFAULT '{"network":false,"shell":false,"maxAgents":8}'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_stacks" ADD CONSTRAINT "agent_instruction_stacks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_stacks" ADD CONSTRAINT "agent_instruction_stacks_instruction_module_id_instruction_modules_id_fk" FOREIGN KEY ("instruction_module_id") REFERENCES "public"."instruction_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_notes" ADD CONSTRAINT "agent_memory_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_notes" ADD CONSTRAINT "agent_memory_notes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_module_id_model_modules_id_fk" FOREIGN KEY ("model_module_id") REFERENCES "public"."model_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_instruction_module_id_instruction_modules_id_fk" FOREIGN KEY ("instruction_module_id") REFERENCES "public"."instruction_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_toolkit_module_id_toolkit_modules_id_fk" FOREIGN KEY ("toolkit_module_id") REFERENCES "public"."toolkit_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_constraints_module_id_constraints_modules_id_fk" FOREIGN KEY ("constraints_module_id") REFERENCES "public"."constraints_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_capabilities_module_id_capabilities_modules_id_fk" FOREIGN KEY ("capabilities_module_id") REFERENCES "public"."capabilities_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_fallback_agent_id_agents_id_fk" FOREIGN KEY ("fallback_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owned_by_agent_id_agents_id_fk" FOREIGN KEY ("owned_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_embedding_profile_id_embedding_model_profiles_id_fk" FOREIGN KEY ("embedding_profile_id") REFERENCES "public"."embedding_model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_index" ADD CONSTRAINT "channel_index_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compressed_summaries" ADD CONSTRAINT "compressed_summaries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_update_log" ADD CONSTRAINT "memory_update_log_note_id_agent_memory_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."agent_memory_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_requested_by_agents_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_worker_template_agents_id_fk" FOREIGN KEY ("worker_template") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spawn_requests" ADD CONSTRAINT "spawn_requests_spv_template_agents_id_fk" FOREIGN KEY ("spv_template") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_spawn_request_id_spawn_requests_id_fk" FOREIGN KEY ("spawn_request_id") REFERENCES "public"."spawn_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_worker_agent_id_agents_id_fk" FOREIGN KEY ("worker_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_spv_agent_id_agents_id_fk" FOREIGN KEY ("spv_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_log" ADD CONSTRAINT "token_usage_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_log" ADD CONSTRAINT "token_usage_log_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_log" ADD CONSTRAINT "token_usage_log_model_module_id_model_modules_id_fk" FOREIGN KEY ("model_module_id") REFERENCES "public"."model_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_nodes" ADD CONSTRAINT "workspace_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_inst_stack_prio_idx" ON "agent_instruction_stacks" USING btree ("agent_id","priority_order");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_idx" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE INDEX "durable_events_channel_seq_idx" ON "durable_events" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_sequence_idx" ON "messages" USING btree ("channel_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_idx" ON "tools" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_nodes_ws_path_idx" ON "workspace_nodes" USING btree ("workspace_id","path");