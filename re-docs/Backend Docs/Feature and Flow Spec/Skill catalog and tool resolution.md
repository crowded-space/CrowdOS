# Skill catalog and tool resolution
> Type: Feature · Status: aligned · Updated: 2026-09-26

## Intent
Skills are reusable capability packs (prompt layer + required tools + workflow pattern) that attach to agents without editing the agent, so operators curate one catalog and assign links per agent. Every agent turn then needs one fast answer: which tool ids may this agent use right now.

## Architectural decision
Two hot-path caches (agent skills, resolved tools — 30s TTL, 500 keys, scope-keyed) with explicit invalidation on every mutation, so context assembly and per-call authorization share one query each and never serve cross-tenant entries [Observed]. Per-agent invalidation is scope-keyed while catalog mutations clear globally — extra misses preferred over stale authorization [Observed]. Empty skill sets are cached too, so skill-less agents cost one query per 30s, not one per turn [Observed]. The seven universal tools (memory + lock + discovery verbs) are hardcoded into resolution but filtered through the live registry with fail-open, so every agent keeps its memory and context-awareness tools even with no toolkit and no skills while a renamed verb is never advertised [Observed]. Assignment re-enables instead of duplicate-inserting (a concurrent-assign `23505` counts as that same re-enable), making the link idempotent even though skill creation is not [Observed]. The update body is validated by a defaults-free schema, so a name-only PUT can never reset stored fields to defaults [Observed, 2026-09-26].

## How it works
`create` inserts a `skills` row with a `skill_<uuid>` id and clears both caches globally; `update` merges only defined fields (promptLayer per-key) and clears globally; `delete` clears globally with `agent_skills` links cascading in the DB. `assignSkill` re-enables an existing link or inserts an enabled one, then invalidates that agent's entries; `removeSkill` hard-deletes the link and returns whether a row existed, then invalidates. `getAgentSkills` serves the scope-keyed cache on hit, else loads enabled links and fans in the linked rows (caching `[]` too). `getResolvedToolsForAgent` unions direct toolkit-module grants, `requiredToolIds` + `optionalToolIds` of active skills, and the seven universals (`open_memory`, `discard_memory_from_context`, `remember`, `lock_in`, `lock_out`, `open_detail`, `load_skill`) — each universal gated on `toolsGate.has`, fail-open per id — then caches. Agents, Modules, and Studio invalidate from outside on toolkit/permission/module writes; `ToolExecutor` authorizes every call against the resolved list and the Runtime middlewares compile context prompts and tool schemas from it.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Skills.md> | Owns `skills`/`agent_skills` rows, both hot-path caches, assignment, and tool-id resolution |
| <../Domain Spec/Runtime.md> | Consumes resolution via `skill-context-middleware` (context prompts) and `tool-schema-middleware` (tool schemas) |
| <../Domain Spec/Tools.md> | Authorizes every tool call against the resolved list (`ToolExecutor`) |
| <../Domain Spec/Agents.md> | Calls `invalidateAgentCaches` on toolkit/permission change; owns the read-only `agents`/`toolkit_modules` inputs |
| <../Domain Spec/Modules.md> | Clears all skill caches on toolkit module writes |

## Current state
Real: skill CRUD, defaults-free partial update validation, idempotent assign/re-enable (incl. concurrent `23505`), hard-delete remove with boolean result, cached agent-skills read, three-source tool union with registry-filtered fail-open universals, mutation + cross-domain invalidation, executor and middleware consumption. Flag-gated: none. Stub: none. Legacy: none.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* optionalToolIds plus recommendedModels are persisted with schema columns or removed from inputs, types, and validators. Accepted-but-discarded fields are forbidden. [Satisfied 2026-09-25]
* Skill reads and writes accept and honor a db override end to end. Ambient-only multi-DB is forbidden.
* getResolvedToolsForAgent validates against the registry or documents an explicit stale-until-skip contract. [Universals validated fail-open 2026-09-26; skill/toolkit grant ids still stale-until-skip]
* Skill changes have a documented subscriber contract beyond route workspace:sync, or are explicitly fan-out only. Authority: Skills standard.
## Open gaps
- The service takes no `db` override, so multi-DB correctness for all reads/writes here is unverified.
- Universals are registry-checked (fail-open), but skill `requiredToolIds`/`optionalToolIds` and toolkit grant ids are still returned unchecked — renamed/unregistered grant ids linger until the executor/schema middleware skip them.
- Whether anything subscribes to skill changes beyond route-level `workspace:sync` (vs polling caches) was not traced.
