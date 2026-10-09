# routes — inventory (dom-routes audit)

Scope: packages/server/src/routes (25 modules + 4 test files, ~4.1k LOC).
Facade: **NONE** (no routes-gate.ts). check-gates.mjs explicitly treats `routes` as a gate-less
folder ("Folders without a gate ... have no declared boundary"). Public surface is the
transport entrypoint: `registerRoutes(app)` (index.ts) + `registerRateLimit(app)` (rate-limit.ts).

## Entry points
- create-app.ts buildServer() → app.register(registerRoutes) + registerRateLimit; global hooks: tenant DB (x-workspace-id, fail-closed 503), pinGate, authGate.requireAuthMounted, CORS allowlist.
- index.ts registers 25 route modules (health, metrics, agents, modules, providers, workspace, categories, channels, channel-mounts, messages, threads, filesystem, skills, tools, mcp, studio, events, queue, runs, artifacts, approvals, search, observability, safety, + rate-limit wired separately).
- Tests: index.test.ts (mount regression pins ChannelMounts + Threads), ratelimit.test.ts, observability.test.ts; workspace-database-routes.test.ts (workspace routes); e2e/*.spec.ts exercise HTTP surface.

## Dependency map (Caller → Route → Gate → Service → Port/Adapter)
- client/desktop → HTTP → routes/* → *-gate.ts → domain service → db/schema | local stores | queues | broker.
- routes/index.ts → all route modules (registerRoutes).
- routes/* → shared/* (exempt), db/schema (direct in safety/search/providers/studio/workspace), Filesystem gate, channel-mount gate.

## Ownership / tables touched directly from routes (no gate)
- safety.ts: channel_settings, workspace_safety_settings, approval_grants (direct drizzle).
- search.ts: channels, messages (raw SQL + drizzle).
- providers.ts: generation/embedding/indexing_model_profiles (direct).
- workspace.ts: workspaces, workspace_settings (direct), + dynamic import channels/channel-local-store (allowlisted bypass).
- studio.ts: agent_instruction_stacks read (direct), contextPipeline.assemble direct (B-10).

## Known bypasses (check-gates KNOWN_VIOLATIONS)
- routes/workspace.ts → ../channels/channel-local-store.js (seed) — still allowlisted (CHN-020/XD-006/WS-015).

## Baseline commands
- npx tsc -p tsconfig.json --noEmit (cwd packages/server) → exit 0.
- npx vitest run src/routes → 3 files, 14 tests, all pass.
- node scripts/check-gates.mjs → **FAIL (exit 1)**: 4 violations, all in threads/thread-service.ts
  (../channels/channel-local-store.js ×3, ../messages/message-local-store.js ×1) — outside routes scope.
