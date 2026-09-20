import { skillsGate } from "../../../skills/skills-gate.js";
import { toolsGate } from "../../../tools/tools-gate.js";
import { agentCompleteTool } from "../../agent-control-tools.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

/**
 * Tools whose schemas are NOT injected on every turn (§21 deferral).
 *
 * Selection rule: a tool is deferred when its schema is BULKY and its relevance
 * is TASK-SPECIFIC. The reflex set below is the opposite — small, and needed to
 * operate or to expand anything else.
 *
 * The reflex set is deliberately complete for the EXPANSION path:
 * `open_detail` and `load_skill` must always be present, or the agent could
 * never load what was deferred and deferral would silently hide capability.
 * Context control (`lock_in`/`lock_out`) and memory tools stay reflex because
 * they are tiny and apply to nearly every turn.
 *
 * INVARIANT (pinned by test): every id in this set must be reachable through
 * `open_detail` — either named by a capability descriptor in the catalog, or
 * reachable by id via the `tool_id` escape hatch. A deferred tool with no
 * descriptor and no escape hatch would be invisible AND unreachable.
 */
export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set<string>([
  // ── Workspace ─── filesystem.read / filesystem.write ──────────────────
  "read_file",
  "list_directory",
  "write_file",
  "edit_file",
  "delete_file",
  // ── Execution ─── sandbox.exec ────────────────────────────────
  "execute_bash",
  "execute_safe",
  // ── Knowledge ─── web.search / docs.index ───────────────────────
  "web_search",
  "search_all_channels",
]);

export class ToolSchemaMiddleware implements IContextMiddleware {
  readonly name = "ToolSchemaMiddleware";
  readonly priority = 40;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, runtimeType } = ctx;

    const requiresTools = ["agentic", "coding", "research", "swarm"].includes(runtimeType);

    // Universal context tools for tool-capable runtimes (agentic/coding/research/swarm).
    // open_detail / load_skill are the §21/§20 expansion verbs: without them
    // discovery would be a dead end, since the agent could never pull in what it
    // was told about.
    const universalContextToolIds = ["lock_in", "lock_out", "open_detail", "load_skill"];

    if (!requiresTools) {
      // Pure conversational/observer: no tools (keep Chat pure 0-1 for hot-reload fidelity).
      // visibleCapabilities is still SET (empty) rather than left undefined: §26
      // lists it as a contract field, so consumers must be able to read it
      // unconditionally instead of defending against absence.
      packet.tools = [];
      packet.visibleCapabilities = [];
      return;
    }

    // C3 local-first: skill rows need PG — fall back to universals alone.
    // (Matches the defense-in-depth intent below: universals always land.)
    let allowedToolIds: string[] = [];
    try {
      allowedToolIds = await skillsGate.getResolvedToolsForAgent(agent.id);
    } catch {
      allowedToolIds = [];
    }
    const compiledTools: any[] = [];

    // §21: split the authorized set into REFLEX tools (injected every turn) and
    // DEFERRED tools (reachable only after an explicit expansion).
    //
    // Why: injecting every authorized schema on every turn is exactly the
    // "token usage, context pollution, and tool confusion" §21 exists to remove.
    // The reflex set is the small, cheap, always-relevant core an agent needs to
    // operate and to EXPAND anything else; the rest is advertised as one-line
    // capability summaries and disclosed on demand.
    //
    // Safety property: deferral never makes a tool unreachable. Every deferred
    // tool is either named by a capability descriptor (expandable via
    // open_detail) or reachable by id (open_detail’s tool_id escape hatch). A
    // test pins that invariant against the live registry.
    const deferred: string[] = [];
    for (const toolId of allowedToolIds) {
      const tool = toolsGate.get(toolId);
      if (!tool) continue;

      if (DEFERRED_TOOL_IDS.has(toolId)) {
        deferred.push(toolId);
        continue;
      }

      compiledTools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      });
    }

    // Inject universal context tools even if skillService is stale/DB unavailable (defense in depth)
    for (const universalId of universalContextToolIds) {
      if (!allowedToolIds.includes(universalId)) {
        const t = toolsGate.get(universalId);
        if (t && !compiledTools.some(ct => ct.name === universalId)) {
          compiledTools.push({ name: t.name, description: t.description, inputSchema: t.parameters });
        }
      }
    }

    // Inject agent lifecycle control tool
    compiledTools.push(agentCompleteTool);

    packet.tools = compiledTools;

    // CrowdOS §26/§21: attach the discovery-first capability view. This is the
    // token-economy half of the contract — the agent can see WHAT is possible
    // (one line per capability) without every tool schema being expanded. The
    // capability ids double as the vocabulary for the open_detail tool below.
    // Lazy import: capabilities-gate transitively reaches this file through
    // tools/skills, so a static import here would close a module cycle and
    // leave ToolSchemaMiddleware uninitialized at ContextPipelineManager
    // construction. Same pattern the agentic runtime uses for runs-gate.
    try {
      const { capabilitiesGate } = await import("../../../capabilities/capabilities-gate.js");
      packet.visibleCapabilities = await capabilitiesGate.visibleFor(agent.id);
    } catch {
      packet.visibleCapabilities = [];
    }

    // A deferred tool is only safe to defer if the model is TOLD it exists. This
    // block is that disclosure: one line per capability, grouped by §21 domain.
    // Without it, deferral would HIDE tools instead of deferring them — the model
    // would have no way to learn that a capability is available at all.
    if (deferred.length > 0) {
      packet.systemPromptBlocks.push({
        id: "available_capabilities",
        priority: 41,
        content: this.renderCapabilityIndex(packet.visibleCapabilities ?? [], deferred),
      });
    }

    // No XML prompt block. No sentinel instruction.
    // Native function calling handles everything.
  }

  /**
   * Render the deferred-tool disclosure block.
   *
   * Lists only capabilities that actually cover a deferred tool, so the index is
   * a truthful map of what is NOT yet loaded rather than a dump of the whole
   * vocabulary. Ends with the explicit next step, because a disclosure the model
   * does not know how to act on is just noise.
   */
  private renderCapabilityIndex(
    visible: ReadonlyArray<{ id: string; domain: string; summary: string }>,
    deferred: readonly string[],
  ): string {
    const lines: string[] = [
      "[AVAILABLE CAPABILITIES — not yet loaded]",
      "These capabilities are available but their tool schemas are NOT in this request.",
      "Call open_detail with a capability_id to load one, or open_detail with a tool_id to load a single tool.",
    ];
    let listed = 0;
    const byDomain = new Map<string, string[]>();
    for (const cap of visible) {
      const list = byDomain.get(cap.domain) ?? [];
      list.push(`- ${cap.id}: ${cap.summary}`);
      byDomain.set(cap.domain, list);
      listed++;
    }
    for (const [domain, entries] of byDomain) {
      lines.push(`\n[${domain}]`);
      lines.push(...entries);
    }
    if (listed === 0) {
      // No descriptor covers the deferred tools — say so plainly rather than
      // printing an empty index the model might read as "nothing available".
      lines.push("", "Use open_detail with a tool_id to load a specific tool.");
    }
    // Naming the deferred tools costs a few tokens and removes all ambiguity about
    // what the expansion verbs can reach.
    lines.push("", `Deferred tools reachable this way: ${[...deferred].sort().join(", ")}.`);
    return lines.join("\n");
  }
}
