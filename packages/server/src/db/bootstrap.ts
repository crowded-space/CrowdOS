import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { closeDatabaseConnection, ensurePgVectorExtension, getSqlClient } from "../Shared/config/database.js";
import { env } from "../Shared/config/env.js";
import { seed } from "./seed.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

async function applyMigrations(): Promise<void> {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Configure it before running migrations.");
  }

  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });

  try {
    await migrate(drizzle(migrationClient), { migrationsFolder });
  } finally {
    await migrationClient.end();
  }
}

// Legacy hand-rolled DDL, kept for one release behind LEGACY_BOOTSTRAP=true.
async function ensureSchema(): Promise<void> {
  const sql = getSqlClient();

  await sql`create extension if not exists vector`;

  const enumStatements = [
    "do $$ begin create type provider_engine as enum ('google', 'openai', 'anthropic', 'ollama', 'custom'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type agent_status as enum ('idle', 'working', 'paused', 'offline'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_sharing_policy as enum ('none', 'horizontal', 'vertical', 'full'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type l3_subtype as enum ('worker', 'supervisor'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type channel_type as enum ('standard', 'pair_private', 'archived'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type message_author_type as enum ('user', 'agent', 'system'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type spawn_failure_policy as enum ('retry', 'escalate'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type spawn_status as enum ('pending', 'in_progress', 'completed', 'failed'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type tool_danger_level as enum ('low', 'medium', 'high'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type runtime_override_type as enum ('runtime_patch', 'temp_permission', 'context_inject'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type runtime_status as enum ('idle', 'working', 'paused', 'offline'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type workspace_status as enum ('CREATED', 'INITIALIZING', 'ACTIVE', 'PAUSED', 'TERMINATED', 'ARCHIVED'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type workspace_scope as enum ('private', 'shared', 'readonly', 'ephemeral'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type artifact_type as enum ('reasoning_trace', 'execution_log', 'analysis_report', 'generated_component', 'task_result', 'runtime_snapshot'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type workspace_node_type as enum ('file', 'directory'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_note_type as enum ('episodic', 'reflection', 'journal', 'semantic', 'tool_result', 'correspondence', 'tension'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_confidence as enum ('low', 'medium', 'high'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_source_type as enum ('direct_experience', 'self_reflection', 'tool_result', 'channel_observation', 'entity_testimony'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_valence as enum ('positive', 'neutral', 'negative', 'mixed', 'unknown'); exception when duplicate_object then null; end $$;",
    "do $$ begin create type memory_lifecycle_status as enum ('active', 'archived', 'suppressed'); exception when duplicate_object then null; end $$;",
  ];

  for (const statement of enumStatements) {
    await sql.unsafe(statement);
  }

  const tableStatements = [
    // ─── CrowdOS Module Tables ─────────────────────────────────────
    `create table if not exists workspace_settings (
      id text primary key,
      global_soft_cap integer not null default 1000000,
      per_provider_budget jsonb default '{}'::jsonb not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists workspaces (
      id text primary key,
      name text not null,
      owner_id text not null,
      status workspace_status default 'CREATED' not null,
      root_path text not null,
      permissions jsonb default '{"network":false,"shell":false,"maxAgents":8}'::jsonb not null,
      constraints jsonb default '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb not null,
      metadata jsonb default '{}'::jsonb not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists workspace_nodes (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      path text not null,
      name text not null,
      type workspace_node_type not null,
      mime_type text,
      size bigint default 0 not null,
      checksum text,
      created_by text not null,
      updated_by text not null,
      metadata jsonb default '{}'::jsonb not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists workspace_events (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      type text not null,
      agent_id text,
      path text,
      payload jsonb default '{}'::jsonb not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists workspace_agents (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      agent_id text not null,
      scope workspace_scope default 'shared' not null,
      permissions jsonb default '{"read":true,"write":false,"execute":false}'::jsonb not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists artifacts (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      producer_agent text not null,
      artifact_type artifact_type not null,
      path text,
      semantic_tags text[] default '{}'::text[] not null,
      metadata jsonb default '{}'::jsonb not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists model_modules (
      id text primary key,
      label text not null,
      provider provider_engine not null,
      model_name text not null,
      api_key text,
      endpoint_url text,
      temperature real not null,
      top_p real not null,
      max_output_tokens integer not null,
      stop_sequences jsonb default '[]'::jsonb not null,
      max_recent_messages integer not null,
      enable_compression boolean default true not null,
      compression_threshold integer not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists instruction_modules (
      id text primary key,
      label text not null,
      base jsonb default '[]'::jsonb not null,
      runtime_patchable boolean default false not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists toolkit_modules (
      id text primary key,
      label text not null,
      tools jsonb default '[]'::jsonb not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists constraints_modules (
      id text primary key,
      label text not null,
      rules jsonb default '[]'::jsonb not null,
      disallowed_actions jsonb default '[]'::jsonb not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists capabilities_modules (
      id text primary key,
      label text not null,
      skills jsonb default '[]'::jsonb not null,
      function_schemas jsonb default '[]'::jsonb not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    // ─── CrowdOS Runtime Tables ──────────────────────────────────
    `create table if not exists runtime_overrides (
      id text primary key,
      target_agent_id text not null,
      override_type runtime_override_type not null,
      instruction_patch jsonb,
      permission_patch jsonb,
      created_by text not null,
      expires_at timestamp with time zone,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists runtime_states (
      session_id text primary key,
      agent_id text not null,
      status runtime_status default 'idle' not null,
      active_task text,
      active_channel_id text,
      started_at timestamp with time zone,
      overrides_applied jsonb default '[]'::jsonb not null,
      error_info jsonb,
      last_heartbeat timestamp with time zone,
      created_at timestamp with time zone default now() not null
    )`,
    // ─── Legacy Model Profiles ───────────────────────────────────
    `create table if not exists generation_model_profiles (
      id text primary key,
      label text not null,
      provider provider_engine not null,
      model_name text not null,
      api_key text,
      endpoint_url text,
      temperature real not null,
      top_p real not null,
      max_output_tokens integer not null,
      stop_sequences jsonb default '[]'::jsonb not null,
      max_recent_messages integer not null,
      enable_compression boolean default true not null,
      compression_threshold integer not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists embedding_model_profiles (
      id text primary key,
      label text not null,
      provider provider_engine not null,
      model_name text not null,
      api_key text,
      endpoint_url text,
      dimensions integer not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists indexing_model_profiles (
      id text primary key,
      label text not null,
      provider provider_engine not null,
      model_name text not null,
      api_key text,
      endpoint_url text,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists tools (
      id text primary key,
      name text not null,
      description text not null,
      handler_id text not null,
      json_schema jsonb default '{}'::jsonb not null,
      danger_level tool_danger_level not null,
      auth_level_required integer not null
    )`,
    // ─── Agents (Identity-Only) ──────────────────────────────────
    `create table if not exists agents (
      id text primary key,
      name text not null,
      title text not null,
      species text,
      avatar text,
      authority_level integer not null,
      l3_subtype l3_subtype,
      model_module_id text not null references model_modules(id) on delete cascade,
      instruction_module_id text not null references instruction_modules(id) on delete cascade,
      toolkit_module_id text references toolkit_modules(id) on delete set null,
      constraints_module_id text references constraints_modules(id) on delete set null,
      capabilities_module_id text references capabilities_modules(id) on delete set null,
      memory_sharing_policy memory_sharing_policy not null,
      is_omniscient boolean default false not null,
      fallback_agent_id text,
      category_perms jsonb default '[]'::jsonb not null,
      permissions jsonb default '{"spawnAgents":false,"patchRuntime":false,"accessAllChannels":false}'::jsonb not null,
      status agent_status default 'offline' not null,
      is_template boolean default false not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists categories (
      id text primary key,
      name text not null,
      owned_by_agent_id text references agents(id) on delete set null,
      embedding_profile_id text references embedding_model_profiles(id),
      created_by text not null,
      position integer not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists channels (
      id text primary key,
      category_id text references categories(id) on delete cascade,
      name text not null,
      type channel_type default 'standard' not null,
      created_by text not null,
      position integer not null,
      created_at timestamp with time zone default now() not null,
      archived_at timestamp with time zone
    )`,
    `create table if not exists messages (
      id text primary key,
      channel_id text not null references channels(id) on delete cascade,
      author_id text not null,
      author_name text not null,
      author_level text not null,
      author_type message_author_type not null,
      content text not null,
      mentions jsonb default '[]'::jsonb not null,
      is_internal_monologue boolean default false not null,
      sequence_number integer not null,
      timestamp timestamp with time zone default now() not null,
      metadata jsonb,
      tool_calls jsonb
    )`,
    `create table if not exists channel_sequences (
      channel_id text primary key references channels(id) on delete cascade,
      last_seq bigint default 0 not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists spawn_requests (
      id text primary key,
      requested_by text not null references agents(id) on delete cascade,
      channel_id text not null references channels(id) on delete cascade,
      worker_template text not null references agents(id) on delete cascade,
      spv_template text not null references agents(id) on delete cascade,
      failure_policy spawn_failure_policy not null,
      max_retries integer not null,
      subtasks jsonb default '[]'::jsonb not null,
      status spawn_status default 'pending' not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists task_files (
      id text primary key,
      spawn_request_id text not null references spawn_requests(id) on delete cascade,
      subtask_id text not null,
      title text not null,
      content text not null,
      worker_agent_id text not null references agents(id) on delete cascade,
      spv_agent_id text not null references agents(id) on delete cascade,
      status spawn_status default 'pending' not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists scheduled_tasks (
      id text primary key,
      cron_expression text not null,
      channel_id text not null references channels(id) on delete cascade,
      target_agent_id text not null references agents(id) on delete cascade,
      task_payload jsonb default '{}'::jsonb not null,
      is_active boolean default true not null,
      next_run timestamp with time zone,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists token_usage_log (
      id text primary key,
      agent_id text not null references agents(id) on delete cascade,
      channel_id text not null references channels(id) on delete cascade,
      model_module_id text references model_modules(id) on delete set null,
      prompt_tokens integer not null,
      completion_tokens integer not null,
      total_tokens integer not null,
      timestamp timestamp with time zone default now() not null
    )`,
    `create table if not exists channel_index (
      channel_id text primary key references channels(id) on delete cascade,
      channel_path text not null,
      topic_summary text not null,
      last_indexed_at timestamp with time zone not null,
      msg_count_since_index integer not null
    )`,
    `create table if not exists compressed_summaries (
      id text primary key,
      channel_id text not null references channels(id) on delete cascade,
      summary text not null,
      covers_up_to_seq integer not null,
      created_at timestamp with time zone default now() not null
    )`,
    `create table if not exists agent_tools (
      agent_id text not null,
      tool_id text not null,
      primary key (agent_id, tool_id)
    )`,
    `create table if not exists agent_memory_notes (
      id text primary key,
      agent_id text not null references agents(id) on delete cascade,
      channel_id text references channels(id) on delete set null,
      note_type memory_note_type not null,
      note_timestamp timestamp with time zone not null,
      importance_score real default 0.5 not null,
      confidence memory_confidence default 'medium' not null,
      source_type memory_source_type default 'direct_experience' not null,
      emotional_valence memory_valence default 'neutral' not null,
      access_count integer default 0 not null,
      last_accessed timestamp with time zone,
      links jsonb default '[]'::jsonb not null,
      contradiction_flags jsonb default '[]'::jsonb not null,
      lifecycle_status memory_lifecycle_status default 'active' not null,
      archived_at timestamp with time zone,
      archive_reason text,
      suppressed_at timestamp with time zone,
      suppress_reason text,
      suppress_until timestamp with time zone,
      hook text not null,
      brief text not null,
      observed text default '' not null,
      interpreted text default '' not null,
      felt_sense text default '' not null,
      future_relevance text default '' not null,
      uncertainty text default '' not null,
      detailed text default '' not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists memory_update_log (
      id text primary key,
      note_id text not null references agent_memory_notes(id) on delete cascade,
      timestamp timestamp with time zone not null,
      reason text not null,
      fields_changed jsonb default '[]'::jsonb not null,
      previous_values jsonb default '{}'::jsonb not null,
      agent_id text,
      action text default 'update' not null
    )`,
    // ─── Modular Skills, MCP & Dynamic Tools Tables ──────────────
    `create table if not exists skills (
      id text primary key,
      name text not null,
      description text not null,
      category text default 'general' not null,
      icon text default '⚡' not null,
      prompt_layer jsonb default '{"systemPromptAdditions":[],"executionGuidelines":[],"fewShotExamples":[]}'::jsonb not null,
      required_tools jsonb default '[]'::jsonb not null,
      optional_tools jsonb default '[]'::jsonb not null,
      recommended_models jsonb default '[]'::jsonb not null,
      workflow_pattern text default 'react' not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists agent_skills (
      agent_id text not null references agents(id) on delete cascade,
      skill_id text not null references skills(id) on delete cascade,
      is_enabled boolean default true not null,
      primary key (agent_id, skill_id)
    )`,
    `create table if not exists mcp_servers (
      id text primary key,
      name text not null,
      transport text not null,
      command text,
      args jsonb default '[]'::jsonb not null,
      server_url text,
      env_vars jsonb default '{}'::jsonb not null,
      is_enabled boolean default true not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists dynamic_tools (
      id text primary key,
      name text not null,
      display_name text not null,
      description text not null,
      category text default 'custom' not null,
      source_type text default 'dynamic' not null,
      source_id text,
      parameters jsonb not null,
      code text not null,
      danger_level text default 'safe' not null,
      auth_level_required integer default 3 not null,
      timeout_ms integer default 30000 not null,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )`,
    `create table if not exists agent_instruction_stacks (
      id text primary key,
      agent_id text not null references agents(id) on delete cascade,
      instruction_module_id text not null references instruction_modules(id) on delete cascade,
      priority_order integer not null,
      is_enabled boolean default true not null
    )`,
  ];

  for (const statement of tableStatements) {
    await sql.unsafe(statement);
  }

  const postTableStatements = [
    "do $$ begin alter table agents add constraint agents_fallback_agent_id_fk foreign key (fallback_agent_id) references agents(id) on delete set null; exception when duplicate_object then null; end $$;",
    "do $$ begin alter table agent_tools add constraint agent_tools_agent_id_agents_id_fk foreign key (agent_id) references agents(id) on delete cascade; exception when duplicate_object then null; end $$;",
    "do $$ begin alter table agent_tools add constraint agent_tools_tool_id_tools_id_fk foreign key (tool_id) references tools(id) on delete cascade; exception when duplicate_object then null; end $$;",
    "create unique index if not exists agents_name_idx on agents(name)",
    "create unique index if not exists messages_channel_sequence_idx on messages(channel_id, sequence_number)",
    "create unique index if not exists tools_name_idx on tools(name)",
    "create unique index if not exists workspace_nodes_ws_path_idx on workspace_nodes(workspace_id, path)",
    "do $$ begin alter table workspace_agents add constraint workspace_agents_agent_id_agents_id_fk foreign key (agent_id) references agents(id) on delete cascade; exception when duplicate_object then null; end $$;",
  ];

  for (const statement of postTableStatements) {
    await sql.unsafe(statement);
  }
}

async function main(): Promise<void> {
  if (process.env.LEGACY_BOOTSTRAP === "true") {
    await ensureSchema();
    console.log("Database schema bootstrap completed (legacy DDL).");
    return;
  }

  await applyMigrations();
  await ensurePgVectorExtension();
  await seed();
  console.log("Database migrations applied and seed data ensured.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection();
  });
