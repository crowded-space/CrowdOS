# Modules Domain — Inventory (Phase 1)

Read-only audit. Baseline commit: 22bb8a0 "UX Update Phase B-G" (main, dirty tree pre-existing; modules domain has one uncommitted working-tree change: module-service.ts google probe no longer defaults a model name — see Ledger M-12).

## Files (packages/server/src/modules/)

| File | LOC | Role |
|---|---|---|
| module-gate.ts | 186 | ONLY cross-domain import surface. Bare re-exports (types, schemas, service fns) + moduleGate object namespaces. |
| module-service.ts | 815 | Dual-tier store owner (PG + local), delete guards, reference validation, connection test, listAll TTL cache, runtime/skills cache invalidation. |
| module-local-store.ts | 264 | JSON-array file truth per kind under <ws>/vfs/.crowdos/*-modules.json. Corruption guard, scope hygiene. |
| module-types.ts | 57 | 5 record interfaces + ProviderEngine + ModuleType + ModuleUnion. |
| module-validators.ts | 56 | Zod schemas (5 create + 5 update partial + providerEngine + paramId) + inferred body types. |
| module-local-mode.test.ts | 244 | 10 tests: local delete guard, tenant scope, corruption guard, pagination, redaction-mask round-trip, plural blockers. |

## Gate export surface (module-gate.ts)

- Types: ModelModule, InstructionModule, ToolkitModule, ConstraintsModule, CapabilitiesModule, ProviderEngine, ModuleType, ModuleUnion; body types Create/Update x5; ModuleParams.
- Schemas: providerEngineSchema, {model,instruction,toolkit,constraints,capabilities}ModuleSchema + update*Schema, paramIdSchema.
- Bare functions: findReferencingAgent, findReferencingAgents, validateModuleReferences, testConnectionHelper, listAllModules, ensureDefaultModules, DEFAULT_INSTRUCTION_MODULE_ID, 5x(list/get/create/update/delete) + testModelModule.
- moduleGate object: findReferencingAgent, findReferencingAgents, validateReferences, ensureDefaults, and {model|instruction|toolkit|constraints|capabilities}.{list,get,create,update,remove} (only model has test). No listAll/testConnection/DEFAULT_MODEL_MODULE_ID entries (deliberate, doc'd).

## Importers (all through module-gate.ts except noted)

| Importer | Uses |
|---|---|
| routes/modules.ts:41-55 | full CRUD + findReferencingAgent scoped 409 pre-checks |
| routes/providers.ts:11 | testConnectionHelper, providerEngineSchema |
| routes/studio.ts:7 | moduleGate.model/constraints/toolkit.get(id, agent.workspaceId) |
| agents/agent-service.ts:313-321 | ensureDefaults, instruction.get fallback, model.get clear |
| agents/agent-service.ts:718-729 | validateReferences (dynamic import) |
| runtime/kernel/middlewares/constraint-safety-middleware.ts:20 | constraints.get(id, ctx.workspaceId) |
| runtime/kernel/context-pipeline-manager.ts:90-91 | model.get(id, ctx.workspaceId) (dynamic, cycle-safe) |
| ~~core/memory-builder.ts:58-68~~ [stale: file deleted 2026-10-07, unstaged; successor: runtime/kernel/context-pipeline-manager.ts:90-91; see audit/domains/core/inventory.md] | model/instruction/toolkit.get(id, agent.workspaceId) |
| shared/core/librarian-runtime.ts:231 | model.get(id) UNSCOPED |
| observability/cost-ledger.ts:262 | model.list() UNSCOPED (dashboard meta) |
| ~~types/index.ts:14~~ | type-only re-export — file deleted 2026-10-07 (dom-types task); zero importers |
| swarm/swarm.e2e.test.ts:28-40 | vi.mock of module-gate |

## Domain-internal imports (legal)
module-gate -> service/validators/types; service -> validators, types, local-store; local-store -> types + shared/core/local-file.

## Cross-domain gate calls (outbound)
- workspace-gate.tierContextFor (module-service.ts:4,67)
- runtime-gate.invalidateModelModuleCache (dynamic, :97-98)
- agents/agent-gate.agentRegistry.list (dynamic, :115)
- skills/skills-gate.invalidateAgentCaches (static, :680-717)

## Persistence / events / routes / jobs
- Tables owned: model_modules, instruction_modules, toolkit_modules, constraints_modules, capabilities_modules (db/schema.ts:74-127).
- FK columns owned by Agents: agents.{model,instruction,toolkit,constraints,capabilities}_module_id (schema.ts:224-228; instruction is NOT NULL + cascade, others set null).
- No queues/jobs in-domain. No socket listeners in-domain; workspace:sync emitted by routes/modules.ts on every mutation.
- Local files: <ws>/vfs/.crowdos/{model,instruction,toolkit,constraints,capabilities}-modules.json.

## Baseline commands (exact)
- npx tsc -p tsconfig.json --noEmit (cwd packages/server) -> EXIT 2; single error OUTSIDE domain: src/memories/memory-retrieval.ts(168,41) TS2559. Zero modules errors.
- npx vitest run src/modules/module-local-mode.test.ts (cwd packages/server) -> EXIT 0; 1 file, 10/10 tests passed, 12.13s (vitest v4.1.7). Log: audit/domains/modules/_vitest-run.log.
- node scripts/check-gates.mjs (cwd packages/server) -> EXIT 0; 1 modules finding: module-local-mode.test.ts -> ../agents/agent-local-store.js (TEST-ONLY, allowlisted finding).

## Test inventory
- module-local-mode.test.ts (10): local delete guard, delete unreferenced, tenant-scoped vs unscoped guard, unscoped write guard exemption, ensureDefaults no-op, corrupt-file refusal + tolerant reads, empty-limit fallback, unscoped get default-folder-only, mask round-trip keeps key, plural blockers.
- context-model-routing.test.ts: imports module-local-store directly for fixtures (check-gates finding).
- swarm.e2e.test.ts: mocks the gate.
- No route-level tests for /api/modules (none exist repo-wide for this route file).
