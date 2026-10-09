# dom-db — PHASE 1 INVENTORY (db area)

Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd (branch: main, ahead 3, dirty from prior audits — no git mutations performed)

## Facade
- Public facade: **NONE**. packages/server/src/db/ has no db-gate.ts (dir listing, 2026-10-07).
- packages/server/scripts/check-gates.mjs documents db explicitly: "Folders without a gate (Shared, types, db, routes, core, adapters) have no declared boundary and their internals stay freely importable until a gate is introduced."
- Consequence: db/schema.ts is imported directly by ~50 files (agents, channels, messages, routes, shared/*, tools, workspace, swarm, threads, observability, runtime, queue...). Not a gate violation today; boundary rule does not yet cover db.

## Files
| File | Role |
|---|---|
| schema.ts (54.6 KB, 46 pgTables, 28 enums) | single source of truth for PG schema; type-only import of workspace-gate types (line 491) |
| migrations/0000..0027 (28 SQL, drizzle journal idx 0..27) | ordered, hand-written after 0010 (meta snapshots stale — see ledger DB-005) |
| bootstrap.ts | db:push entry: migrate() + ensurePgVectorExtension + seed; LEGACY_BOOTSTRAP=true frozen DDL path (deprecated) |
| seed.ts | idempotent-by-lookup seed: instruction modules, toolkit, default-assistant + Librarian agents, workspace_settings 'default', #general + categories/channels |
| check.ts | roundtrip probe: insert model/instruction module, agent, channel, message; verify; delete (cleanup) |
| backfill-encrypt-secrets.ts | dry-run default / --apply: encrypt api_key columns + mcp_servers.env_vars |
| create-workspace-crowdos.ts | one-shot: ensure workspace 'crowdos' row + LocalFilesystem.initialize() |

## Dependency map (Caller -> Facade -> Service -> Port -> Adapter)
- No facade. Direct: Callers (routes/*, domains/*, shared/*, worker.ts, desktop fork) -> db/schema.js table objects -> shared/config/database.js getDb()/withTransaction() (pooled postgres-js + drizzle) -> Postgres.
- db -> shared/config/database.js, shared/config/env.js, shared/core/secret-box.js, shared/core/redact.js; type-only -> workspace/workspace-gate.js (type-level cycle only; erased at runtime).
- Outbound consumers of db scripts: packages/server/package.json (db:push/db:seed/db:check/db:encrypt-secrets); packages/desktop/main/ensure-database.ts forks compiled db/bootstrap.js (first-run migrate+seed); CI runs drizzle-kit migrate + db:seed; drizzle.config.ts points at src/db/schema.ts + src/db/migrations.

## Tables owned (all in schema.ts)
model/instruction/toolkit/constraints/capabilities modules; runtime_overrides, runtime_states; legacy model profiles x3; tools; agents, agent_tools; categories, channels, messages, channel_sequences; spawn_requests, task_files, scheduled_tasks; token_usage_log; channel_index, compressed_summaries; agent_memory_notes, memory_update_log; workspace_settings, workspaces, workspace_agents, artifacts; swarm_tasks, delegations, approval_requests; skills, agent_skills, mcp_servers, agent_instruction_stacks; durable_events; api_keys; runs, runs_compensation; threads, thread_sequences; channel_settings, workspace_safety_settings, approval_grants.

## Env / config
- DATABASE_URL: CLI-only per shared/config/env.ts + database.ts comments (runtime reads workspace.json records; record-only tiers). DB_POOL_MAX / DB_CONNECT_TIMEOUT_S read via process.env in getSqlClient() (undocumented in env schema; defaults 20 / 10s).
- LEGACY_BOOTSTRAP flag (env.ts) toggles the frozen DDL path.

## Tests in area
- channel-sequences.concurrency.test.ts: describe.skipIf(!DATABASE_URL); needs real dev DB. In this checkout: no packages/server/.env, root .env has no DATABASE_URL -> skipped.
- No other *.test.ts under src/db. No e2e or audit/domains/db coverage of db scripts (prior state: audit/domains/db did not exist).

## Entry points / jobs / events
- One-shot CLI scripts (above); desktop first-run fork; CI migrate+seed. No queue consumers inside db/. No events emitted. durable_events written by events domain (schema owned here).

