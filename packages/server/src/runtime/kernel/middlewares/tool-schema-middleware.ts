import { skillsGate } from "../../../skills/skills-gate.js";
import { toolsGate } from "../../../tools/tools-gate.js";
import { agentCompleteTool } from "../../agent-control-tools.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

export class ToolSchemaMiddleware implements IContextMiddleware {
  readonly name = "ToolSchemaMiddleware";
  readonly priority = 40;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, runtimeType } = ctx;

    const requiresTools = ["agentic", "coding", "research", "swarm"].includes(runtimeType);

    // Universal context tools for tool-capable runtimes (agentic/coding/research/swarm)
    const universalContextToolIds = ["lock_in", "lock_out"];

    if (!requiresTools) {
      // Pure conversational/observer: no tools (keep Chat pure 0-1 for hot-reload fidelity)
      packet.tools = [];
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

    for (const toolId of allowedToolIds) {
      const tool = toolsGate.get(toolId);
      if (!tool) continue;

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

    // No XML prompt block. No sentinel instruction.
    // Native function calling handles everything.
  }
}
