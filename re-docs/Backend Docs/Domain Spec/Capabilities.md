# Capabilities

## Purpose
CrowdOS §21 capability vocabulary. A capability is an operational-domain grouping of tools,
externalized as data so an agent can be told WHAT the system can do without being handed every
tool’s JSON schema up front. Owns the descriptor catalog, the per-workspace manifest overlay, the
discovery-first view, and lazy expansion.

A capability is not a Tool and not a Runtime (§20/§21 are explicit about the three being
distinct). This domain never executes anything — it only describes, filters, and expands.

Capabilities are ADVISORY groupings. No authorization path in the system checks a capability id:
`ToolExecutor` authorizes tool ids only (grant + authority level), so advertising a capability never
grants anything, and hiding one never revokes anything. This domain is discovery metadata that
mirrors the tool-level rules — it is not, and does not claim to be, a security boundary.

## Feature Scope
In-scope:
- The §21 vocabulary: eight operational domains (workspace, memory, tooling, planning, execution,
  swarm, observation, knowledge) and the document’s capability ids verbatim.
- Built-in descriptor catalog mapped to real registry tool ids.
 - Per-workspace manifest overlay (`<workspaceFolder>/vfs/.crowdos/capabilities.json`, canon 2026-09-22) for add/override/hide.
- Availability filtering: a capability with no LIVE, agent-authorized tool inside the agent's
  authority level is not advertised (the same grant + `authLevelRequired` rule `ToolExecutor` enforces).
- Discovery-first summaries (`visibleFor`) and lazy expansion (`expand`).
- `visible_capabilities` on the runtime packet (§26).
Non-goals (other domains):
- Tool registration and execution → Tools (`toolRegistry`, `ToolExecutor`).
- Per-call authorization → Tools (`ToolExecutor.execute` re-authorizes every call).
- Tool-schema compilation onto the packet → Runtime (`tool-schema-middleware.ts`).
- The `open_detail` expansion VERB lives in Tools (`tool-registry.ts`); this domain supplies the data.
- Skill (as opposed to capability) semantics → Skills (§20).
- Transport → none yet (no REST surface; consumption is via the packet and the `open_detail` tool).

## Expect
- `[Observed]` `listDescriptors()` (internal — not a gate port) returns the built-in vocabulary merged
  with the workspace manifest, sorted by §21 domain order then id. Stable order across calls.
- `[Observed]` A descriptor whose `tools` are all absent from the live registry is EXCLUDED from
  `visibleFor()`. The §21 vocabulary is larger than today’s implementation; advertising an
  unrealized capability would invite the model to plan around a tool that cannot run.
- `[Observed]` A descriptor whose tools are live but NOT granted to the agent is also excluded —
  discovery cannot drift from enforcement because both read `skillsGate.getResolvedToolsForAgent`.
- `[Observed]` A tool whose `authLevelRequired` the agent's `authorityLevel` fails (executor rule:
  `authorityLevel > (authLevelRequired ?? 0)` rejects, omniscient bypasses; no declared level =
  L0-only, the executor's fail-closed default) is excluded even when granted;
  the level is read via `agentGate.getById(agentId, undefined, workspaceId)`. Partially authorized
  capabilities are advertised with ONLY the usable subset; a capability with no usable tool at all
  is excluded entirely (e.g. an L3 agent never sees `sandbox.exec` when only `execute_bash` is live).
- `[Observed]` When the agent profile cannot be resolved (unknown agent, lookup failure),
  `visibleFor()` returns `[]` and `expand()` returns `null` — the authority rule cannot be evaluated,
  so nothing is claimed (same stance as the resolver failure below).
- `[Observed]` `visibleFor()` returns `{ id, domain, summary, available }` and NO argument schemas.
  This is the token-economy contract. `available` is always `true` by construction: descriptors with
  no usable tool are excluded rather than listed as unavailable.
- `[Observed]` `expand(agentId, capabilityId)` returns full `toolSchemas`, filtered to the agent’s
  grant AND authority level, or `null` when the capability is unknown / manifest-hidden / has no
  usable tool for this agent.
- `[Observed]` Capability ids are never checked by any authorization path (advisory only): the
  boundaries of this domain are discovery, disclosure, and filtering — enforcement stays per tool
  in `ToolExecutor`.
- `[Observed]` Expansion DISCLOSES shape; it never grants access. `ToolExecutor` still authorizes each
  call independently.
- `[Observed]` A malformed or unreadable manifest degrades to the built-in vocabulary; discovery can
  never be the reason a run fails to start.
- `[Observed]` A manifest entry that cannot be placed in one of the eight domains is ignored (an
  unknown id has no domain and therefore no home).
- `[Observed]` When the resolver is unavailable (no PG / no roster), `visibleFor()` returns `[]` — no
  capability is provably invocable, so none is claimed.

## Flow
1. `listDescriptors()` merges `BUILTIN_CAPABILITIES` with `mergeManifest(builtins, manifest)` Non-array capabilities/disabled are warned-and-ignored (was throw-DoS); descriptors deep-copied, catalog frozen (2026-09-25).
    (`capability-service.ts`), where the manifest is read from `<workspaceFolder>/vfs/.crowdos/capabilities.json`.
2. `visibleFor(agentId, workspaceId)` resolves the agent’s authorized tool ids via
   `skillsGate.getResolvedToolsForAgent(agentId)`, resolves the agent's authority tier via
   `agentGate.getById`, then keeps only descriptors with ≥1 tool that is authorized, present in
   `toolsGate`, AND within the agent's authority level (fail-closed `?? 0` default, omniscient
   bypasses).
3. `ToolSchemaMiddleware` (priority 40) attaches the result to `packet.visibleCapabilities`.
4. `ContextAssembler` lifts it onto the assembled `ContextPacket` / `RuntimePacket` as
   `visibleCapabilities` (§26).
5. On demand, the agent calls `open_detail`: with no `capability_id` it lists the visible capabilities;
   with an id it calls `expand()` and receives the full schemas as JSON.
6. `open_detail` and `load_skill` are injected as universals for tool-capable runtimes
   (`skill-service.ts` resolution step 5, mirrored in `tool-schema-middleware.ts`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `capabilities-gate.ts` | Thin facade: re-exports types/catalog/merge and exposes `capabilitiesGate` ports only |
| `capability-types.ts` | `CapabilityDomain`, `CapabilityDescriptor`, `VisibleCapability`, `ExpandedCapability`, `CapabilityManifest` |
| `capability-catalog.ts` | The §21 vocabulary: 27 descriptors across the eight domains |
| `capability-service.ts` | Manifest merge, availability + authority-level filter, discovery, lazy expansion |
| `capabilities.test.ts` | 36 tests: vocabulary shape, discovery invariants, authority-level filtering (incl. fail-closed `?? 0` default), expansion scoping, manifest overlay, merge purity, summary sanitization |
| `capability-catalog.integrity.test.ts` | 4 tests pinning the catalog against the REAL tool registry (no mocks) |

## Ports
- `CapabilityDomain` — the eight §21 operational domains.
- `CAPABILITY_DOMAINS` — the domain list in §21 order.
- `CapabilityDescriptor` — `{ id, domain, summary, tools, source }`, the externalized record.
- `VisibleCapability` — `{ id, domain, summary, available }`, the discovery unit.
- `ExpandedCapability` — descriptor plus `toolSchemas`.
- `CapabilityManifest` — `{ capabilities?, disabled? }`, the workspace overlay shape.
- `CapabilitySource` — `"builtin" | "manifest"`.
- `BUILTIN_CAPABILITIES` — the read-only built-in catalog. open_detail id collides with the tool id (kept: vocabulary pins document ids; rename needs rollout plan). 	ools: [] descriptors are intentionally vocabulary-only.
- `mergeManifest(builtins, manifest)` — pure overlay merge (exported for tests/diagnostics). Non-array capabilities/disabled are warned-and-ignored (was throw-DoS); descriptors deep-copied, catalog frozen (2026-09-25).
- `capabilitiesGate.visibleFor(agentId, workspaceId?)` — discovery-first view (empty/unknown
  agentId, unresolvable profile, or failed resolver returns []; summaries sanitized to 300
  single-line chars). Unscoped callers get built-in vocabulary ONLY — never another workspace's
  manifest (2026-09-25 isolation fix).
- `capabilitiesGate.expand(agentId, capabilityId, workspaceId?)` — lazy expansion or `null`.
- `capabilitiesGate.get(capabilityId, workspaceId?)` — one descriptor or `null`.
- (Removed 2026-09-25: `capabilitiesGate.list` — zero callers; `listDescriptors` stays internal.)

## Relations
Gates this domain calls:
- Skills (`skills/skills-gate.ts`) — `getResolvedToolsForAgent` for the authorization set.
- Tools (`tools/tools-gate.ts`) — `get` for registry liveness, schema shape, and `authLevelRequired`.
- Agents (`agents/agent-gate.ts`) — `getById` for the agent's `authorityLevel` / `isOmniscient`,
  so discovery applies the same authority rule `ToolExecutor` enforces.
Shared imports (exempt): `shared/core/local-file.ts` for the manifest read.
Known outside callers of `capabilitiesGate`:
- Runtime: `tool-schema-middleware.ts` (attaches `visibleCapabilities`).
- Tools: `tool-registry.ts` `open_detail` handler (lists and expands).

## Emits-Listens
- None. This domain is a pure read/describe layer and never touches a broker.

## Owns
- No database tables.
 - `<workspaceFolder>/vfs/.crowdos/capabilities.json` (read-only; the workspace owns the file’s content).

## Flags
- None. The manifest is the configuration surface; there is no env rollback switch because the
  discovery view is additive (an empty capability list simply means the agent sees no capability
  summary, and tools still work exactly as before).

## Decisions
- `[Observed]` Availability filtering is the load-bearing decision: the §21 vocabulary is declared in
  full but only the REALIZED, AUTHORIZED (grant + authority level) subset is advertised. This is what
  lets the catalog track the document without becoming a source of hallucinated tool calls.
- `[Observed]` Discovery and enforcement read the same resolver
  (`skillsGate.getResolvedToolsForAgent`) and the same authority rule (`ToolExecutor`'s
  `authorityLevel > (authLevelRequired ?? 0)` check — fail-closed default included — fed from
  `agentGate.getById`), so the advertised set
  cannot drift from the invocable set.
- `[Observed]` `expand()` is agent-scoped and returns `null` rather than a partial or empty schema set,
  so an agent cannot distinguish "hidden" from "nonexistent" and cannot probe the vocabulary.
- `[Observed]` Summaries are constrained to ONE line and carry no schemas — the token-economy unit.
- `[Observed]` `mergeManifest` is pure and separately tested, so overlay behavior is verifiable without
  filesystem setup.
- `[Observed]` A manifest `disabled` list can remove a built-in id entirely — the workspace is the
  isolation boundary (§30) and may narrow its own vocabulary.
- `[Inferred]` Capability ids double as the vocabulary for `open_detail`; there is deliberately no
  separate naming scheme.
- `[Observed]` **The packet no longer carries every authorized schema.** `ToolSchemaMiddleware` splits
  the authorized set into a REFLEX set (injected every turn: context control, memory, and the two
  expansion verbs) and a DEFERRED set (`read_file`/`list_directory`/`write_file`/`edit_file`/
  `delete_file`/`execute_bash`/`execute_safe`/`web_search`/`search_all_channels`). Selection rule:
  defer when the schema is BULKY and relevance is TASK-SPECIFIC. Measured on the current registry:
  **2031 tokens of schemas → 1404 reflex + a ~120-token capability index, a net saving of ~507
  tokens (25%) per turn.** The saving scales with the tool set, which is the point — it is a fixed
  cost replaced by a per-task cost.
- `[Observed]` **A deferred tool is disclosed, not hidden.** The middleware renders an
  `[AVAILABLE CAPABILITIES — not yet loaded]` block naming the deferred tools and telling the model
  exactly how to load them. Without that disclosure deferral would silently remove capability.
- `[Observed]` **Deferral has a guarded safety invariant.** Every deferred id must be reachable:
  either named by a capability descriptor (discoverable + expandable) or loadable by id through
  `open_detail`’s `tool_id` escape hatch. Note the hatch is HANDLER-LEVEL prose, not schema: the
  published `open_detail` JSON schema declares only `capability_id` (`tool-registry.ts` parameters),
  while the handler also accepts `tool_id` — an agent must infer it from the description/prompt
  block. `tool-deferral-invariant.test.ts` pins reachability against the LIVE registry and catalog
  (descriptor coverage plus registry existence), so deferring an unnamed tool fails the build.
- `[Observed]` The expansion verbs (`open_detail`, `load_skill`) are permanently in the reflex set —
  deferring them would deadlock the scheme, since the agent could not load what was deferred.
- `[Observed]` **Expansion is a two-step hand-off, not just a disclosure.** `open_detail` records the
  schemas it discloses against the calling RUN (`shared/core/tool-expansion-registry.ts`), and the
  agentic runtime unions them into the packet before each model call. Disclosure alone would leave
  the tool uncallable, because native function calling only accepts schemas present in the request.
  This is the step that makes §21 "lazily expanded" true rather than aspirational.
- `[Observed]` The expansion registry is bounded three ways: per-run (`clearToolExpansions` on the
  runtime’s `finally`), 64 tools per run, and a 30-minute TTL sweep. A crashed run cannot pin memory.
- `[Observed]` A run with no id records nothing (`recordToolExpansion` returns 0). Direct runtime
  invocations therefore see the un-deferred set only — the honest fallback, not a silent widening.
- `[Observed]` `withExpandedTools` returns the SAME packet reference when nothing was expanded, so the
  un-expanded path stays byte-identical to pre-§21 behavior.
- `[Observed]` The registry lives in Shared, not in Tools or Runtime, because both domains need it and
  a gate-to-gate edge between them would be a module cycle.
- `[Observed]` **The Zone A door is deliberately OUTSIDE the capability vocabulary.** `read_workspace_local` is
  registered, L0-only (`authLevelRequired: 0`), and named by no descriptor in `BUILTIN_CAPABILITIES`. That is a
  decision, not an oversight, and it is safe for exactly one reason: the tool is also **not deferred**
  (`DEFERRED_TOOL_IDS` does not list it), so it is injected into the packet every turn as a reflex tool. The
  §21 invariant only constrains DEFERRED tools; an un-named reflex tool is visible by construction.
- `[Observed]` **Why not catalog-name it instead.** The deferral invariant (`tool-deferral-invariant.test.ts`)
  requires every deferred id to be reachable — either named by a descriptor or loadable by id through
  `open_detail`’s `tool_id` escape hatch (handler-level, not schema-level — see the decision above). Catalog-naming `read_workspace_local` would therefore be
  *compatible* with the invariant, but it would make the Zone A door depend on an expansion round trip for
  the L0 agents that are the only callers. Keeping it reflex and un-named removes that dependency, at the
  cost of one always-present schema — the same trade the other reflex tools already make. (O5, `re-docs/UI UX
  Overhaul/02-filesystem-model.md` §6.)

## Architectural Standard (Target)
> Status: Target. Discovery-first plus lazy expansion plus availability filtering stay; a REST surface and
> capability-level authorization are the gaps.
Capabilities MUST stay externalized data. No capability logic may live in prompt prose.
A capability with no live, granted, authority-level-usable tool MUST NOT be advertised. Availability
filtering (registry + grant + authority level) stays.
Discovery MUST NOT carry argument schemas; expansion MUST be explicit and per-capability.
Expansion MUST NOT grant access. Per-call authorization stays in `ToolExecutor`; capability ids stay
advisory and MUST NOT be treated as an authorization boundary.
Manifest failures MUST degrade to the built-in vocabulary, never throw.
Capability ids MUST match the §21 vocabulary verbatim; new ids require a document change or a
workspace manifest entry.

## Failure + Resume
- Missing manifest / unreadable directory → built-in vocabulary; no error surfaced to the agent.
- Malformed manifest JSON → `readJsonObject` returns `{}` → treated as no overlay.
- Manifest entry without a resolvable domain → entry ignored.
- Resolver unavailable (no PG) → `visibleFor` returns `[]`; `expand` returns `null`.
- Agent profile unresolvable (unknown id / lookup failure) → same as the resolver case: `visibleFor`
  returns `[]`, `expand` returns `null`; no partial or level-guessed advertisement.
- Unknown/unauthorized capability id on expand → `null`, and `open_detail` returns an error string
  that points the agent back to the list call.
- Resume is N/A (synchronous reads, no background work, no timers).

## Gaps
- No REST surface yet: the client cannot browse or edit the capability vocabulary, and
  `capabilities.json` must be authored by hand.
- Expansion is per-RUN, not per-turn or persisted. A resumed run starts with no expansions
  (the registry is keyed by run id and cleared on terminal state), so a resumed agent re-expands.
- The registry is in-process, so a run executed across an API/worker boundary would lose its
  expansions on the worker. Same single-process assumption the lock store and event log carry.
- `open_detail` returns raw JSON, so an expansion costs more tokens than a purpose-built formatter.
- **Capabilities are advisory groupings only — documented, not enforced.** No code path anywhere
  authorizes by capability id: there is no capability-level authorization, no capability ACL, and no
  check that an agent "holds" a capability. Authorizing a tool effectively opens every capability
  that lists it, and a manifest-disabled capability still executes if its tools are granted.
  Implementing capability-level authorization is an unestimated FEATURE (not a bug fix) and is
  deliberately not built; until it exists, treat capability ids as discovery metadata, never as a
  security boundary.
- `VisibleCapability.available` is dead weight: always `true` (a descriptor with no usable tool is
  excluded from the list instead of being flagged), nothing in this codebase branches on it, and
  only key-presence assertions cover it. Removing the field requires editing
  `runtime/kernel/discovery-context.test.ts` (outside this domain) — kept for packet-shape stability
  until that change is coordinated.
- The `open_detail` `tool_id` escape hatch is accepted by the tool handler but NOT declared in its
  published JSON schema (`tools/tool-registry.ts` — outside this domain), so an agent can only learn
  of it from the description/prompt block. Schema + description fix belongs to Tools.
- Discovery now does one extra profile read per call (`agentGate.getById` for the authority level),
  on top of the manifest read below — same once-per-turn cost profile, but it is another uncached
  lookup on that path.
- Authority filtering hides realized tools from most tiers by design: `search_all_channels` is
  `authLevelRequired: 0`, so `docs.index` is advertised only to L0/omniscient agents; `execute_bash`
  is L0–L1, so an L3 agent sees `sandbox.exec` only when `execute_safe` (open to all) is live.
  Honest, but it means the advertised vocabulary now also varies by authority tier, not just by
  workspace.
- Many §21 ids are declared but unrealized (`task.plan`, `swarm.create`,
  `repo.map`, …), so they are invisible to agents. That is the honest behavior, but it means the
  advertised vocabulary is currently a subset of the document’s. (`artifact.create` left this
  list when `create_artifact` landed: it is advertised to L0/L1 agents.)
- The manifest is read per call with no cache; a hot loop calling `visibleFor` repeatedly re-reads and
  re-parses the file. Acceptable at current call frequency (once per turn per agent), but it is a
  whole-file read on a hot-ish path.
- `open_detail` returns raw JSON rather than a rendered table, so the expansion costs more tokens than
  a purpose-built formatter would.
- The vocabulary is L1–L3-shaped. `read_workspace_local` (L0 only) is the one realized tool with no
  descriptor, so the L0 capability view is not described by this catalog at all. Whether L0 needs its own
  descriptors — or whether the L0 set stays deliberately small enough not to need them — is unverified.
