# Skills Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/skills/` (9 files), facade `skills-gate.ts`, callers, persistence, docs. Time-boxed ~30 min: unverified items marked Low/Medium confidence.

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| `skills-gate.ts` | 1952 | Facade: `skillsGate` object (13 ports) + named Markdown re-exports + validator schema/type re-exports. No logic. |
| `skill-service.ts` | 11501 | `SkillService` singleton: CRUD, assignment, tool resolution, 2 TtlCaches. |
| `skill-types.ts` | 1347 | `SkillDefinition`/prompt-layer/create-update input types. In-domain only. |
| `skill-validators.ts` | 2356 | Zod: `createSkillSchema` (defaults), defaults-free `updateSkillSchema`, `skillParamsSchema`. Category enum INCLUDES "general" (:16). |
| `markdown-skill-types.ts` | 3017 | §20 taxonomy (closed 3-value), `MarkdownSkill`/`SkillSummary`/`SkillLoadReport`. |
| `markdown-skill-parser.ts` | 6074 | Hand-rolled front-matter parser; parse failures are values; body cap 50k. |
| `markdown-skill-store.ts` | 7335 | Directory load/discovery/expansion/composition; 256k file cap; workspace-scoped. |
| `skill-service.test.ts` | 18356 | 16 tests, scripted in-memory drizzle fake. |
| `markdown-skills.test.ts` | 11803 | 21 tests, tmpdir fixtures. |

Naming: kebab-case OK, gate `skills-gate.ts` OK (AGENTS.md §1/§2).

## 2. Facade surface (exact, `skills-gate.ts`)

Named exports: `createSkillSchema`, `updateSkillSchema`, `skillParamsSchema`, types `CreateSkillBody`, `UpdateSkillBody`, `SkillParams`, named re-exports `listSummaries as listMarkdownSummaries`, `getSkill as getMarkdownSkill`.

`skillsGate` ports (:30-47): `list`, `getById`, `create`, `update`, `delete`, `getAgentSkills`, `assignSkill`, `removeSkill`, `getResolvedToolsForAgent`, `invalidateAgentCaches`, `listMarkdownSummaries`, `getMarkdownSkill`, `composeMarkdownSkills` (composeSkills imported but not re-exported standalone — only on the object).

Doc check: Domain Spec `Ports` matches gate exports. Internal types (`SkillDefinition`, `MarkdownSkill`) stay in-domain.

## 3. Importers (grep-verified, src only)

Static: `routes/skills.ts:11` (gate + schemas + types), `routes/studio.ts:5`, `runtime/kernel/middlewares/skill-context-middleware.ts:1`, `runtime/kernel/middlewares/tool-schema-middleware.ts:1`, `tools/tool-executor.ts:7`, `agents/agent-service.ts:14`, `modules/module-service.ts:8`, `capabilities/capability-service.ts:30`.
Dynamic: `tools/tool-registry.ts:1154` (open_detail tool_id escape hatch), `:1270` (load_skill), `skill-service.ts:272` (tools-gate — in-domain, cycle-avoidance).
Tests (mock or use gate): `approvals/approval-flow.integration.test.ts:92,158,207,260`; `capabilities/capabilities.test.ts:70`; `runtime/runtimes/agentic-runtime.test.ts:34`; `runtime/runtime-lifecycle.test.ts:356`; `tools/executor.timeout.test.ts:7`, `read-workspace-local.test.ts:29`, `tool-executor.batch.test.ts:3`, `tool-registry.honest.test.ts:13`, `tool-registry.bullmq.test.ts:17-96`; `runtime/kernel/discovery-context.test.ts` (real middleware, tmpdir).

Bypass: `routes/studio.ts:4,152-154` imports `agentSkills` table from `db/schema.ts` and writes it directly (delete+insert) — not a check-gates violation (db not gated) but violates AGENTS.md §2 (REST handlers call gates; one owner per table). See SK-001.

## 4. Entry points

- REST (`routes/skills.ts`, registered `routes/index.ts:44`): GET /api/skills (category/limit 1-200), GET/PUT/DELETE /api/skills/:id, POST /api/skills (201), GET /api/agents/:id/skills, POST/DELETE /api/agents/:id/skills/:skillId (FK 23503→404; `workspace:sync` emit after each mutation).
- REST (`routes/studio.ts`): GET/PUT /api/studio/agents/:id/manifest (skillIds replace path bypasses gate — SK-001).
- Local-mode guard: `shared/core/local-mode-guard.ts:28` guards `/api/skills` prefix — GET /api/skills degrades 200-empty, other methods 501.
- Runtime: `SkillContextMiddleware` (priority 30, DB full-form + Markdown discovery/deferral), `ToolSchemaMiddleware` (priority 40, universals + capability index).
- Tools: `ToolExecutor.execute` per-call authorization; `load_skill`/open_detail in tool-registry.
- Cross-domain invalidators: agent-service.ts:473,508; module-service.ts (~global clears); studio.ts:165.

## 5. Persistence

- `skills` (schema.ts:839-865; migration 0000:316-327 + 0022 optional_tools/recommended_models): id text PK, name/description NOT NULL, category default 'general', icon default, prompt_layer jsonb NOT NULL default, workflow_pattern default 'react', required/optional tools + recommended_models jsonb NOT NULL default '[]'. No unique on name; no index beyond PK.
- `agent_skills` (schema.ts:867-873; 0000:63-68 + FK 0000:441-442): (agent_id, skill_id) PK, is_enabled default true, both FKs ON DELETE CASCADE.
- `bootstrap.ts:388-403` legacy DDL already had optional_tools/recommended_models (pre-0022 parity).
- Relations declared (schema.ts:900-912). No local-file tier for DB half (local-mode guard covers).

## 6. Config

- No env reads in-domain (Flags: none OK).
- Limits hardcoded: list clamp 1-200 (:90), cache 30s/500 (:68-69), markdown file 256k / body 50k, discovery limit 1-500.
- Tenant: `getDb()` via ALS (`runWithDb`, create-app.ts:303) or global pool; caches keyed `dbScopeKey()` (per-handle WeakMap → wsN / "global").

## 7. Dependency map (Caller → Facade → Service → Port → Adapter)

```
routes/skills.ts ──────────────► skillsGate ─► skillService ─► drizzle(getDb ALS/global) ─► skills, agent_skills
routes/studio.ts ──(GET via gate; PUT writes agentSkills table DIRECTLY, non-txn)─► db/schema
runtime skill-context-middleware ─► skillsGate.getAgentSkills / listMarkdownSummaries / getMarkdownSkill ─► skillService / markdown-skill-store ─► fs (<ws>/vfs/.crowdos/skills)
runtime tool-schema-middleware ─► skillsGate.getResolvedToolsForAgent ─► skillService ─► toolsGate.has (dynamic)
tools/tool-executor ─► skillsGate.getResolvedToolsForAgent ─► skillService (ambient DB!) [SK-002]
tools/tool-registry (load_skill/open_detail) ─► skillsGate markdown ports
agents/agent-service, modules/module-service, routes/studio ─► skillsGate.invalidateAgentCaches
capabilities/capability-service ─► skillsGate.getResolvedToolsForAgent
```

Cycles: none static in-domain; `skill-service → tools-gate` is dynamic (cycle avoidance); middleware comment notes a real module cycle ToolSchemaMiddleware→tools-gate→tool-registry→register-socket-server→runtime-gate→context-assembler (discovery-context.test.ts:14-19).

Hidden globals: process-wide `skillService` singleton caches; `dbScopeKey` WeakMap; global broker used only by routes.

