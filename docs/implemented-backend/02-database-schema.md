# Database Schema

**File:** \src/db/schema.ts\ (Drizzle ORM)
**Driver:** postgres.js
**Extension:** pgvector

---

## Module Tables (5) — Identity-Driven Agent Architecture

### model_modules
id text PK | label text NOT NULL | provider provider_engine (enum: google|openai|anthropic|ollama|custom) | model_name text NOT NULL | api_key text | endpoint_url text | temperature real | top_p real | max_output_tokens integer | stop_sequences jsonb (string[]) | max_recent_messages integer | enable_compression boolean | compression_threshold integer | created_at timestamptz | updated_at timestamptz

### instruction_modules
id text PK | label text NOT NULL | base jsonb (string[]) | runtime_patchable boolean | created_at | updated_at

### toolkit_modules
id text PK | label text NOT NULL | tools jsonb (string[]) | created_at | updated_at

### constraints_modules
id text PK | label text NOT NULL | rules jsonb (string[]) | disallowed_actions jsonb (string[]) | created_at | updated_at

### capabilities_modules
id text PK | label text NOT NULL | skills jsonb (string[]) | function_schemas jsonb (Record[]) | created_at | updated_at

---

## Runtime Tables (2)

### runtime_overrides
id text PK | target_agent_id text NOT NULL | override_type runtime_override_type (enum: runtime_patch|temp_permission|context_inject) | instruction_patch jsonb (InstructionPatch) | permission_patch jsonb (PermissionPatch) | created_by text | expires_at timestamptz | created_at

### runtime_states
session_id text PK | agent_id text NOT NULL | status runtime_status (enum: idle|working|paused|offline) | active_task text | active_channel_id text | started_at timestamptz | overrides_applied jsonb (string[]) | error_info jsonb ({code,message,timestamp}) | last_heartbeat timestamptz | created_at

---

## Legacy Provider Profiles (3)

### generation_model_profiles (duplicate of model_modules)
### embedding_model_profiles (has dimensions column)
### indexing_model_profiles (minimal)

---

## Core Entity Tables (5)

### tools
id text PK | name text (unique) | description text | handler_id text | json_schema jsonb | danger_level tool_danger_level (enum: low|medium|high) | auth_level_required integer

### agents
id text PK | name text (unique) | title text | species text | avatar text | authority_level integer (0-3) | l3_subtype l3_subtype (enum: worker|supervisor) | model_module_id FK | instruction_module_id FK | toolkit_module_id FK | constraints_module_id FK | capabilities_module_id FK | memory_sharing_policy memory_sharing_policy (enum: none|horizontal|vertical|full) | is_omniscient boolean | fallback_agent_id FK (self-ref) | category_perms jsonb (string[]) | permissions jsonb ({spawnAgents,patchRuntime,accessAllChannels}) | status agent_status (enum: idle|working|paused|offline) | is_template boolean | created_at | updated_at

### agent_tools (M2M join)
agent_id FK + tool_id FK, PK(agent_id,tool_id)

### categories
id text PK | name text | owned_by_agent_id FK | embedding_profile_id FK | created_by text | position integer | created_at

### channels
id text PK | category_id FK | name text | type channel_type (enum: standard|pair_private|archived) | created_by text | position integer | created_at | archived_at

---

## Communication Tables (2)

### messages
id text PK | channel_id FK (cascade) | author_id text | author_name text | author_level text | author_type message_author_type (enum: user|agent|system) | content text | mentions jsonb (MentionMetadata[]) | is_internal_monologue boolean | sequence_number integer | timestamp timestamptz | UNIQUE(channel_id, sequence_number)

### spawn_requests
id text PK | requested_by FK | channel_id FK (cascade) | worker_template FK | spv_template FK | failure_policy spawn_failure_policy (enum: retry|escalate) | max_retries integer | subtasks jsonb (SubtaskDefinition[]) | status spawn_status (enum: pending|in_progress|completed|failed) | created_at

### task_files
id text PK | spawn_request_id FK (cascade) | subtask_id text | title text | content text | worker_agent_id FK | spv_agent_id FK | status spawn_status | created_at

### scheduled_tasks
id text PK | cron_expression text | channel_id FK (cascade) | target_agent_id FK | task_payload jsonb | is_active boolean | next_run timestamptz | created_at

---

## Budget & Indexing Tables (4)

### token_usage_log
id text PK | agent_id FK | channel_id FK (cascade) | model_module_id FK | prompt_tokens integer | completion_tokens integer | total_tokens integer | timestamp timestamptz

### channel_index
channel_id PK FK (cascade) | channel_path text | topic_summary text | last_indexed_at timestamptz | msg_count_since_index integer

### compressed_summaries
id text PK | channel_id FK (cascade) | summary text | covers_up_to_seq integer | created_at timestamptz

### workspace_settings
id text PK (default "default") | global_soft_cap integer | per_provider_budget jsonb | updated_at timestamptz

---

## Workspace Sandbox Tables (5)

### workspaces
id PK | name | owner_id | status (enum: CREATED|INITIALIZING|ACTIVE|PAUSED|TERMINATED|ARCHIVED) | root_path | permissions jsonb | constraints jsonb | metadata jsonb | created_at | updated_at

### workspace_nodes
id PK | workspace_id FK | path (unique per workspace) | name | type (file|directory) | mime_type | size | checksum | created_by | updated_by | metadata | created_at | updated_at | UNIQUE(workspace_id, path)

### workspace_events
id PK | workspace_id FK | type | agent_id | path | payload jsonb | created_at

### workspace_agents
id PK | workspace_id FK | agent_id FK | scope (enum: private|shared|readonly|ephemeral) | permissions jsonb | created_at

### artifacts
id PK | workspace_id FK | producer_agent | artifact_type (enum: reasoning_trace|execution_log|analysis_report|generated_component|task_result|runtime_snapshot) | path | semantic_tags text[] | metadata jsonb | created_at

---

## Enums (PostgreSQL Native)

provider_engine: google|openai|anthropic|ollama|custom
agent_status, runtime_status: idle|working|paused|offline
memory_sharing_policy: none|horizontal|vertical|full
l3_subtype: worker|supervisor
channel_type: standard|pair_private|archived
message_author_type: user|agent|system
spawn_failure_policy: retry|escalate
spawn_status: pending|in_progress|completed|failed
tool_danger_level: low|medium|high
runtime_override_type: runtime_patch|temp_permission|context_inject
workspace_status: CREATED|INITIALIZING|ACTIVE|PAUSED|TERMINATED|ARCHIVED
workspace_scope: private|shared|readonly|ephemeral
artifact_type: reasoning_trace|execution_log|analysis_report|generated_component|task_result|runtime_snapshot
workspace_node_type: file|directory
