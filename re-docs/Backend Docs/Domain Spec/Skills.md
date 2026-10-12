# Skills

## Purpose
Skill catalog plus agent-skill assignment plus per-agent tool resolution. It owns `skills` and `agent_skills` rows, and answers the two hot-path questions the rest of the system asks every turn: which skills does this agent have, and which tool ids may it use (direct toolkit grants + skill-required tools + hardcoded universals), served from short-TTL caches with explicit invalidation.

Since the §20 calibration pass the domain has a SECOND, local-first half: Markdown skills on disk
(`<workspaceFolder>/vfs/.crowdos/skills/<slug>.md`; canon 2026-09-22 — inside the owning workspace
folder, and discovery/expansion are workspace-scoped). CrowdOS §17 names Markdown as the persistence format for Skills
and Instructions, and §20 requires skills to be "discoverable and expanded on demand rather than
fully injected into every context". The Markdown store supplies both: a discovery view carrying one
line per skill and no body, and explicit per-skill expansion (`load_skill`, or a trigger match).

## Feature Scope
In-scope:
- Skill row CRUD (`skills` table).
- Agent↔skill assignment with enable/disable (`agent_skills` table).
- Resolved tool-id list per agent (toolkit grants + active-skill requirements + universal tools).
- Cache invalidation for the two hot-path caches.
Non-goals (other domains):
- Tool registration/execution and safety policy → Tools (`toolRegistry`, `ToolExecutor.execute`, `Guard`).
- Prompt assembly and tool-schema compilation → Runtime (`skill-context-middleware.ts`, `tool-schema-middleware.ts` consume this domain).
- Agent identity/CRUD and roster → Agents (calls `invalidateAgentCaches` on toolkit/permission change).
- Module tables (`toolkit_modules` reads are reference only; writes live in Modules).
- Transport (REST payloads, validation error mapping) → Routes (`routes/skills.ts` calls `skillsGate`, never contains logic).

## Expect
- `[Observed]` Every in-process mutation (create/update/delete/assign/remove) invalidates the caches immediately; reads go through a 30s TTL scope-keyed cache, so this process sees its own mutations on the next read, and a foreign writer's change is at worst TTL-bounded (≤30s).
- `[Observed]` `list()` limit clamps to 1–200 (default 100), ordered by name; category filter is exact match.
- `[Observed]` `getById()` returns `null` when missing, never throws.
- `[Observed]` `update()` returns `null` when the skill is missing; `delete()` returns `false` when nothing was deleted. The body is validated by a defaults-free `updateSkillSchema`: an omitted field is never reset to a default (a name-only PUT preserves category/icon/promptLayer/tools/workflowPattern).
- `[Observed]` `assignSkill()` is an upsert: existing link is re-enabled (`isEnabled: true`), missing link is inserted enabled; a concurrent-assign unique violation (`23505`) is treated as that same re-enable.
- `[Observed]` `getAgentSkills()` only returns skills behind `isEnabled` links, and caches the empty result too.
- `[Observed]` `getResolvedToolsForAgent()` always includes the seven universals (`open_memory`, `discard_memory_from_context`, `remember`, `lock_in`, `lock_out`, `open_detail`, `load_skill`) even when the agent or its toolkit module is missing; each universal is filtered through the live registry (`toolsGate.has`) and fails open per-id when the registry cannot answer.
- `[Observed]` Markdown discovery/expansion is single-workspace: a nullish/empty `workspaceId` reads the default scope folder only — never a fan-out that could leak another workspace's skill bodies.
- `[Observed]` A skill file dropped during discovery logs `[skills] skill file skipped: <reason>` (`console.warn`) so parse errors surface even to callers that only destructure `{ skills }`.
- `[Inferred]` `create()` is not idempotent — each call mints a new `skill_<uuid>` id, so caller retries duplicate.

## Flow
1. List/get: `skillsGate.list({ category, limit })` queries with optional equality filter, name-ordered, clamped limit (`skill-service.ts:84-97`); `skillsGate.getById(id)` is a single `findFirst`, `null` when missing (`skill-service.ts:99-105`).
2. Create: `skillsGate.create(input)` inserts a `skills` row with a full `skill_<uuid>` id (was 32-bit truncated - 2026-09-25), defaulted category/icon/promptLayer/workflowPattern (`skill-service.ts:107-133`); then clears both caches globally (`skill-service.ts:131`).
   2026-09-25 audit fix: `optionalToolIds` and `recommendedModels` are now persisted (migration `0022_skills_optional_tools_models.sql` adds `optional_tools`/`recommended_models` jsonb columns mirroring the legacy-DDL shape; `create`/`update` write them). Previously both fields were accepted by the validator, silently dropped, and read back as `[]` — data loss on every save.
3. Update: `skillsGate.update(id, input)` re-reads via `getById` and returns `null` when missing (`skill-service.ts:135-138`); merges only defined fields over existing (promptLayer merges per-key over existing) (`skill-service.ts:145-155`); writes, clears caches globally, returns mapped row (`skill-service.ts:157-163`).
   2026-09-26 audit fix (CRITICAL): the update body is now validated by an explicit `updateSkillSchema` with NO defaults — `createSkillSchema.partial()` kept `.partial()` but Zod kept the `.default()`s, so a name-only PUT injected `category: "general"`, `icon: "⚡"`, empty tool/model arrays, and an empty promptLayer and wiped the stored values (`skill-validators.ts` update schema).
4. Delete: `skillsGate.delete(id)` deletes by id, clears caches, returns whether a row existed (`skill-service.ts:166-171`); `agent_skills` links cascade in the DB (`schema.ts:887`).
5. Assign/remove: `assignSkill` re-enables an existing link or inserts an enabled one, then invalidates that agent's cache entries (`skill-service.ts:197-221`); `removeSkill` hard-deletes the link row (returns boolean (was silent void - 2026-09-25)), then invalidates that agent's entries (`skill-service.ts:223-228`).
   2026-09-25 audit fix: unknown agent/skill ids in the REST attach/detach routes map FK violations (`23503`) to a clean 404 instead of a raw 500; non-FK errors still propagate (`routes/skills.ts:141-144`, `routes/skills.ts:159-161`).
6. Agent skills read: `getAgentSkills(agentId)` serves the scope-keyed cache on hit (`skill-service.ts:174-176`); on miss loads enabled links, caches `[]` directly when there are none, otherwise fans in the linked skill rows via `inArray` and caches (`skill-service.ts:178-195`).
7. Tool resolution: `getResolvedToolsForAgent(agentId)` serves cache on hit (`skill-service.ts:231-233`); on miss unions (1) direct grants from the agent's `toolkitModuleId` (`skill-service.ts:239-245`), (2) `requiredToolIds` + `optionalToolIds` of active skills (`skill-service.ts:248-256`), (3) the seven universal tools, each gated on `toolsGate.has` with per-id fail-open and a module-level fail-open warn (`skill-service.ts:262-283`); caches and returns (`skill-service.ts:285-287`).
8. Invalidation from outside: Agents calls `invalidateAgentCaches(id)` on toolkit/permission change (`agent-service.ts:220`); Modules clears all caches on module writes (`module-service.ts:311`); Studio clears per-agent on toolkit updates (`routes/studio.ts:160`).
9. Consumption: ToolExecutor authorizes every call against the resolved list (`tool-executor.ts:167`); Runtime middlewares compile context prompts and tool schemas from it (`skill-context-middleware.ts:10`, `tool-schema-middleware.ts:24`); REST exposes CRUD plus agent-skill attach/detach with `workspace:sync` emits on mutation (`routes/skills.ts:14-16`, emission after each successful write).

## Current Implementation
| File | Role |
| ---- | ---- |
| `skills-gate.ts` | Thin facade: re-exports the validated body/param schemas and the Markdown discovery ports, and exposes `skillsGate` (dead type exports — `SkillDefinition`/`SkillPromptLayer`/`CreateSkillInput`/`UpdateSkillInput`, bare `loadSkills`/`loadEnabledSkills` — removed 2026-09-26; single surface) |
| `skill-service.ts` | `SkillService` singleton: CRUD, assignment, cached resolution, invalidation |
| `skill-types.ts` | `SkillDefinition` / prompt-layer / create/update input types (in-domain; not gate exports) |
| `skill-validators.ts` | Zod schemas: `createSkillSchema` (defaults applied), explicit defaults-free `updateSkillSchema`, id params; shared few-shot/category/workflow enums |
| `markdown-skill-types.ts` | §20 taxonomy + `MarkdownSkill` / `SkillSummary` / parse + load result types |
| `markdown-skill-parser.ts` | Dependency-free front-matter + Markdown body parser (unquoting, trailing `#` comments, folded-value rejection); parse failures are values |
| `markdown-skill-store.ts` | `skills/<slug>.md` discovery, lazy expansion, composition — single-workspace scope, skipped-file `console.warn` logging |
| `markdown-skills.test.ts` | 21 tests: taxonomy closure, parse resilience, discovery without bodies, composition, workspace scoping, skip logging |
| `skill-service.test.ts` | 16 tests: CRUD roundtrip, defaults-free update merge, cache invalidation, 23505 re-enable, seven universals (scripted in-memory DB) |

Key types/functions: `mapSkill` (row → definition with `general`/`⚡`/empty-layer defaults + element-wise few-shot validation, `skill-service.ts:47`); `TtlCache<SkillDefinition[]>` + `TtlCache<string[]>` (30s, 500 keys, `skill-service.ts:68-69`); `invalidateAgentCaches(agentId?)` (scoped delete vs global clear, `skill-service.ts:71`); `skillService` singleton (`skill-service.ts:291`).

## Ports
Gate exports (`skills-gate.ts` — the domain's only import surface; internal types like `SkillDefinition`/`MarkdownSkill` stay in-domain):
- `CreateSkillBody` — validated creation-body type (zod inferred).
- `UpdateSkillBody` — validated update-body type (zod inferred).
- `SkillParams` — validated `{ id }` param type.
- `createSkillSchema` — validates creation bodies (name/description required, rest defaulted).
- `updateSkillSchema` — defaults-free partial update schema: omitted fields keep their stored values (2026-09-26; `createSkillSchema.partial()` used to keep the `.default()`s and reset fields on every PUT).
- `skillParamsSchema` — validates id params.
- `listMarkdownSummaries(filter?)` — enabled Markdown skills, discovery view (named re-export).
- `getMarkdownSkill(skillId, workspaceId?)` — one full Markdown skill or `null` (named re-export).
- `skillsGate.list` — lists skills by optional category, clamped limit.
- `skillsGate.getById` — returns one skill or `null`.
- `skillsGate.create` — inserts skill, clears caches, returns mapped row.
- `skillsGate.update` — merges defined fields (promptLayer per-key), `null` when missing.
- `skillsGate.delete` — deletes skill, `true` when a row existed.
- `skillsGate.getAgentSkills` — cached enabled skills for an agent.
- `skillsGate.assignSkill` — upsert-enables an agent↔skill link. Concurrent assigns are idempotent (23505 caught - 2026-09-25).
- `skillsGate.removeSkill` — hard-deletes an agent↔skill link, boolean result.
- `skillsGate.replaceAgentSkills` — atomic all-or-nothing skill-set replacement in one transaction + owned cache invalidation (SK-001 fixed); studio manifest calls this port, never direct `agentSkills` writes.
- `skillsGate.replaceAgentSkills` — atomic all-or-nothing skill-set replacement in one transaction + owned cache invalidation (SK-001 fixed); studio manifest calls this port, never direct `agentSkills` writes. Sibling: `agentGate.replaceInstructionStack` — same atomicity for instruction stacks (XD-015 fixed).
- `skillsGate.replaceAgentSkills` — atomic all-or-nothing skill-set replacement in one transaction + owned cache invalidation (SK-001 fixed); studio manifest calls this port, never direct `agentSkills` writes. Sibling: `agentGate.replaceInstructionStack` — same atomicity for instruction stacks (XD-015 fixed). Invalidation is cross-scope by agent suffix (SK-003 fixed). Universal ids are the shared `UNIVERSAL_TOOL_IDS` from tools-gate (SK-008 fixed).
- `skillsGate.getResolvedToolsForAgent` — cached union of toolkit + skill (required+optional) + seven universal tool ids, universals filtered via toolsGate.has fail-open - 2026-09-26.
- `skillsGate.invalidateAgentCaches` — per-agent scoped delete, or global clear when no id.
- `skillsGate.listMarkdownSummaries` — same as the named re-export, via the single surface.
- `skillsGate.getMarkdownSkill` — same as the named re-export, via the single surface.
- `skillsGate.composeMarkdownSkills(ids, workspaceId?)` — compose several skills into one workflow body. Returns `{ body, resolved, missing, disabled }` — `disabled` is the subset of `missing` that exists but is opted out, so callers can tell "unknown" from "installed but disabled". Single `loadSkills` + Map (was N+1 reloads); files capped at 256k, bodies at 50k with `truncated` flag (2026-09-25).

## Relations
Gates this domain calls:
- `toolsGate.has` only — dynamic import inside universal-tool filtering (`skill-service.ts:272`); a registry outage fails open per id (grants the verb, warn) instead of dropping it. The service otherwise imports only `shared/config/database.ts` (`getDb`, `dbScopeKey`), `shared/core/ttl-cache.ts`, and `db/schema.ts` for its static graph.
  The §20 Markdown half imports only `shared/core/local-file.ts` (exempt) for the store root.
Known outside callers of `skillsGate`:
- Tools: `tool-executor.ts` (per-call authorization, `tool-executor.ts:167`).
- Agents: `agent-service.ts` (`invalidateAgentCaches` on toolkit/permission change).
- Modules: `module-service.ts` (global invalidation on module writes).
- Runtime: `skill-context-middleware.ts`, `tool-schema-middleware.ts` (context assembly + schema compilation).
- Routes: `routes/skills.ts` (full CRUD + attach/detach), `routes/studio.ts` (agent skills + resolved tools + invalidation).
Tables shared with other domains (read-only from here, owned elsewhere):
- `agents` / `toolkit_modules` (Agents, Modules) — read for direct tool grants; never written here.

## Emits-Listens
- None in-domain — the service never touches a broker; mutation fan-out (`workspace:sync`) is emitted by route transport (`routes/skills.ts:14-16`).

## Owns
- `skills` (writes: insert, update, delete)
- `agent_skills` (writes: insert, re-enable update, delete)

## Flags
- None — no `process.env` reads in `skill-service.ts`, `skill-types.ts`, `skill-validators.ts`, or `skills-gate.ts`.

## Decisions
- `[Observed]` Two hot-path caches (30s TTL, 500 keys, scope-keyed) with explicit invalidation on every mutation — context assembly and per-call authorization share one query each and never serve cross-tenant entries (`skill-service.ts:68-69`, `skill-service.ts:174`, `skill-service.ts:231`).
- `[Observed]` Per-agent invalidation is scope-keyed to the mutating request's scope; global clear on catalog mutations — extra misses preferred over stale authorization (`skill-service.ts:71`).
- `[Observed]` Empty skill sets are cached, not just populated ones — agents without skills cost one query per 30s, not one per turn (`skill-service.ts:182-185`).
- `[Observed]` Universal tools are hardcoded into resolution (memory + lock + discovery verbs work for every agent even with no toolkit and no skills), but each id is filtered through the live registry with per-id and module-level fail-open — advertising a renamed/vapor universal is the failure we avoid, dropping a live verb offline is not (`skill-service.ts:262-283`). Defense in depth mirrored by `tool-schema-middleware.ts:39` re-injecting lock tools when the list is stale.
- `[Observed]` `assignSkill` re-enables instead of duplicate-inserting — assignment is idempotent at the link level even though skill creation is not (`skill-service.ts:197-221`).
- `[Observed]` Update merges per-field over the existing row (promptLayer per-key) — partial updates never wipe unmentioned fields (`skill-service.ts:145-155`); the validation layer guarantees this too: `updateSkillSchema` carries no defaults (`skill-validators.ts`).
- `[Inferred]` Gate wraps a singleton service instance rather than static functions — caches live exactly once per process, which is what makes invalidation from other domains effective (`skill-service.ts:291`, `skills-gate.ts:30`).
- `[Observed]` **§20 taxonomy is CLOSED.** An unknown `category` is a parse ERROR, not a silent
  coercion. §20 names exactly three categories (cognitive / operational / swarm); coercing would let
  a typo quietly disable the taxonomy the document defines. Quoted or ` #`-suffixed front-matter
  values are normalized before the check (`markdown-skill-parser.ts:45-51`, `:112`).
- `[Observed]` **Parse failures are values, not throws.** A malformed skill is skipped and its reason
  is reported in `SkillLoadReport.errors` AND logged (`[skills] skill file skipped:` — the discovery
  callers destructure `{ skills }` only, so without the log the reason would vanish);
  one bad Markdown file can never break context assembly (`markdown-skill-store.ts:101-110`).
- `[Observed]` **Markdown discovery is single-workspace.** A nullish scope resolves the default
  folder only — never `candidateWorkspaceScopes()` fan-out — so expansion cannot serve another
  workspace's skill bodies (`markdown-skill-store.ts:97-103`).
- `[Observed]` **Discovery carries no bodies.** `listSummaries` returns `{id,name,description,category,
  topic}` only; the Markdown body is reachable solely through the gate ports `getMarkdownSkill`/`composeMarkdownSkills` (2026-09-25). This is the
  §20 "expanded on demand" property made structural rather than a convention.
- `[Observed]` **Assigned (DB) skills keep their full form; Markdown skills are deferred.** An
  assigned skill is an explicit grant with no trigger model, so silently deferring it would change
  agent behavior rather than save tokens. A Markdown skill is deferred to a one-line entry unless its
  derived trigger appears in the user input or the agent calls `load_skill`.
- `[Observed]` **Triggers are derived from skill identity (name + topic), matched lexically.** §20 has
  no trigger field yet, and deriving avoids imposing extra authoring burden. Lexical matching keeps
  the middleware inspectable and consistent with the Interpreter’s "no heavy reasoning" rule (§24).
- `[Observed]` **Composition preserves request order** and reports missing ids instead of failing —
  order is semantically meaningful because a later skill may refine an earlier one.
- `[Observed]` `open_detail` and `load_skill` are injected as universals for tool-capable runtimes,
  filtered through `toolsGate.has` (fail-open) so discovery without an expansion verb would be a
  dead end, but a renamed verb is not advertised (`skill-service.ts:262-283`).
- `[Observed]` Duplicate Markdown skill ids are resolved deterministically (files are sorted, first
  wins) and the collision is reported rather than silently dropped.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Hot-path caches plus universals plus idempotent assign stay; phantom fields and db override are the gaps.
Markdown on disk MUST stay the §17 persistence format for Skills. Skills MUST NOT be introduced as
PG-only rows without a Markdown counterpart.
The §20 taxonomy (cognitive / operational / swarm) MUST stay closed. An unrecognized category MUST
be rejected, never coerced.
Discovery MUST NOT carry skill bodies. Wholesale prompt injection of every active skill is forbidden
by §20.
Expansion MUST be available as an explicit verb (`load_skill`) so a deferred skill is always reachable.
Skill files MUST be individually fault-isolated: one malformed file MUST NOT fail a load.
Composition MUST preserve request order and MUST report unresolvable ids rather than silently dropping
them.
Two hot-path caches with 30s TTL, scope keys, and explicit invalidation stay. Context assembly plus per-call authorization share one query each and never serve cross-tenant entries.
Per-agent invalidation stays scope-keyed with global clear on catalog mutations. Empty skill sets stay cached.
Universal tools hardcoded into resolution stay, filtered through the live registry with fail-open (2026-09-26), with middleware re-injection when the list is stale.
assignSkill stays idempotent at the link level. Update stays per-field merge, never wiping unmentioned fields; the update validator must stay defaults-free so a name-only PUT cannot reset stored fields.
optionalToolIds plus recommendedModels MUST be persisted with schema columns or removed from inputs, types, and validators. Accepted-but-discarded fields are forbidden.
Skill reads and writes MUST accept and honor a db override end to end like Agents. Ambient-only multi-DB is forbidden.
getResolvedToolsForAgent MUST validate every id against the registry or document an explicit stale-until-skip contract (universals now validated fail-open - 2026-09-26; skill/toolkit grant ids still skip-later). Silent renamed-tool linger is forbidden.
Skill changes MUST have a documented subscriber contract beyond route workspace:sync, or be explicitly fan-out only.
## Failure + Resume
- Missing skill: `getById`/`update` return `null`, `delete` returns `false`; routes map these to 404 (`skill-service.ts:99`, `skill-service.ts:135`, `skill-service.ts:166`, `routes/skills.ts:66-68,96-98,114-116`).
- Route error mapping: Zod/`statusCode: 400` failures stay 400; any other service throw (DB outage included) is a 500 — server failures are no longer mislabeled as client errors (`routes/skills.ts:22-36`).
- `assignSkill` performs no existence check on either side: unknown agent or skill ids surface as a DB FK throw, not a domain error (`skill-service.ts:197`; REST maps `23503` → 404 at `routes/skills.ts:141-144`); `removeSkill` on a missing link returns `false` (`skill-service.ts:223`).
- Resolution degrades gracefully: missing agent, missing toolkit module, or no links all resolve to the universal-only list rather than throwing (`skill-service.ts:239`); a tools-registry outage grants the universals fail-open with a warn (`skill-service.ts:280-283`).
- Resume is N/A (synchronous CRUD, no background work, no timers); cache staleness self-heals at TTL expiry even if an invalidation call is missed.

## Gaps
- No local file tier for the DB half: the `skills`/`agent_skills` CRUD goes through `getDb()`, so in Local mode (no database) the route guard answers 501 for writes and an empty list for reads. The §17 Markdown half (`<workspaceFolder>/vfs/.crowdos/skills/<slug>.md`) IS the local truth for markdown skills, but it is discovery/composition only — no Markdown-backed create/update/assign parity (2026-09-23 local-mode CRUD audit).
- ~~`optionalToolIds` and `recommendedModels` are accepted but never persisted~~ — FIXED 2026-09-25: migration `0022` adds the columns (`NOT NULL DEFAULT '[]'`, no backfill needed since `mapSkill` already defaulted reads to `[]`), and `create`/`update` now write both fields. Note the legacy `LEGACY_BOOTSTRAP` DDL in `db/bootstrap.ts` already declared these columns — only the drizzle schema/migration set lacked them, so DBs bootstrapped either way now agree.
- `update()` re-reads via ambient `getDb()`, same pattern as Agents — a caller `db` override has no effect here since the service takes no override at all; multi-DB correctness is unverified.
- `getResolvedToolsForAgent` validates the seven universals against the registry (fail-open, 2026-09-26), but skill `requiredToolIds`/`optionalToolIds` and toolkit-module grant ids are still returned unchecked — renamed/unregistered grant ids linger until `ToolExecutor`/`tool-schema-middleware` skip them (`tool-schema-middleware.ts:28`).
- Whether anything subscribes to skill changes beyond route-level `workspace:sync` (vs polling caches) was not traced; the domain itself has no `listens`.
- 2026-10-07 SK-002 fixed: ToolExecutor authorizes inside the agent row's handle (`runWithDb(agentDb, ...)`, `tool-executor.ts:358-361`) instead of ambient-only ALS — no port signature change. Remaining gap: end-to-end split-DB route/worker integration test not yet added (unit fixture `skill-service.test.ts:529` covers two tenant handles).
- 2026-10-07 SK-003 fixed: `invalidateAgentCaches(agentId)` suffix-matches `:agentId` across all scopes (`skill-service.ts:79-81`, `ttl-cache.ts:50-57`); old comment claiming scope-keyed delete was safe is corrected. Extra cross-scope misses are the accepted cost (30s TTL unchanged).
- 2026-10-07 note: `update()`/`create()` still re-read via ambient `getDb()` with no db override param (unchanged by the SK-002 fix, which binds at the executor); multi-DB CRUD correctness remains unverified.
