# Capability discovery and expansion flow

Status: aligned. Domain specs: <../Domain Spec/Capabilities.md> <../Domain Spec/Skills.md> <../Domain Spec/Context.md> <../Domain Spec/Tools.md>

## Purpose
How an agent learns what the system can do (§21 capabilities) and what reusable specialization is
installed (§20 skills) WITHOUT paying for every schema and body on every turn — and how it then
pulls in exactly what it needs.

This flow exists because wholesale injection is the default failure mode of an agent platform: every
tool schema and every skill prompt is prepended to every request, so context cost grows with the size
of the installation rather than the size of the task. CrowdOS names this directly — §21 wants
capabilities "externalized, discoverable, lazily expanded"; §20 wants skills "discoverable and
expanded on demand rather than fully injected into every context".

## Expect
- `[Observed]` A turn’s system prompt carries capability SUMMARIES and skill NAMES, never the full
  schema set or every skill body.
- `[Observed]` The agent has two expansion verbs: `open_detail` (capabilities) and `load_skill`
  (skills). Both are injected as universals for tool-capable runtimes.
- `[Observed]` An expanded capability becomes CALLABLE on the next model call. `open_detail` records
  the disclosed schemas against the run and the agentic runtime unions them into the request —
  without that hand-off the agent would be told a capability exists, expand it, and still be unable
  to invoke it.
- `[Observed]` Nothing advertised is unreachable, and nothing reachable is unadvertised. "Reachable"
  here means the executor's full rule: grant (`skillsGate.getResolvedToolsForAgent`) PLUS authority
  level (`agent.authorityLevel` vs the tool's `authLevelRequired` — fail-closed `?? 0` default, so
  an undeclared level is L0-only), so discovery does not advertise
  a capability the executor would reject on level grounds.
- `[Observed]` Expansion never widens authorization: `ToolExecutor` re-authorizes every call.
- `[Observed]` Capability ids themselves are never authorized — the grouping is advisory discovery
  metadata; enforcement is per tool id.

## Flow
1. **Assembly.** `ToolSchemaMiddleware` (priority 40) runs inside the parallel lane of
   `ContextPipelineManager` alongside `SkillContextMiddleware` (priority 30).
2. **Capability discovery.** The middleware calls `capabilitiesGate.visibleFor(agent.id, workspaceId)`,
   which resolves the agent’s authorized tool ids, resolves the agent's authority tier
   (`agentGate.getById`), and keeps only descriptors with ≥1 tool that is granted, live in the
   registry, AND within the agent's authority level (fail-closed `?? 0` default, omniscient
   bypasses — the same rule
   `ToolExecutor` enforces). The result is `{id, domain, summary, available}` per capability
   (`available` is always true; unusable capabilities are excluded, not flagged).
3. **Skill discovery.** `SkillContextMiddleware` loads installed Markdown skills and splits them:
   skills whose derived trigger matches the user input are expanded inline; the rest become one-line
   entries naming their id. DB-assigned skills keep their full form (an explicit grant is not
   something to defer).
4. **Packet.** `ContextAssembler` lifts `visibleCapabilities` onto the `ContextPacket` /
   `RuntimePacket` (§26). Tool schemas for the agent’s RESOLVED tools are still compiled onto
   `packet.tools` — capabilities are an additional discovery layer, not a replacement for the
   authorization path.
5. **Expansion.** The model calls `open_detail` with a `capability_id` (or none, to list) and/or
   `load_skill` with a `skill_id` (or several comma-separated ids, to compose).
6. **Return + make callable.** `open_detail` returns the expanded tool schemas as JSON AND records
   them against the current run (`shared/core/tool-expansion-registry.ts`). `load_skill` returns the
   Markdown body. Both are ordinary tool results and land in history like any other.
6a. **Next iteration.** The agentic runtime unions the run’s recorded schemas into the packet before
   the next model call (`withExpandedTools`), so the expanded tool is now invocable. Returns the same
   packet reference when nothing was expanded, keeping the un-expanded path byte-identical.
7. **Execution.** Any tool the agent then calls is authorized independently in `ToolExecutor` against
   the same resolved list AND the same authority-level rule the discovery layer used.

## Failure modes
- No PG / no roster → `visibleFor` returns `[]` and Markdown skills still load; the agent simply sees
  no capability summaries. Tool execution is unaffected.
- Agent profile unresolvable → `visibleFor` returns `[]` / `expand` returns `null` (the authority
  rule cannot be evaluated), same recovery path as above.
- Malformed `capabilities.json` → built-in vocabulary; discovery still works.
- Malformed skill file → that file is skipped and reported; the other skills load.
- Unknown or unauthorized id on expansion → `null` / error string pointing back at the list call, so
  the agent can recover without a retry storm.

## Target Contract
> Status: Target. Discovery-first plus two expansion verbs plus availability filtering (registry +
> grant + authority level) are the standard.
No new tool or skill may be added by injecting its full schema or body into every turn. Add it to the
capability catalog or as a Markdown skill and let discovery surface it.
The advertised set MUST equal the invocable set. A capability or skill that cannot be invoked MUST NOT
be advertised, and one that can MUST be reachable.
Expansion MUST NOT be an authorization boundary. It discloses shape only.
Skill bodies MUST live on disk as Markdown (§17). Capability descriptors MUST be data, not prose.
