import { skillsGate } from "../../../Skills/skillsGate.js";
import { toolsGate } from "../../../tools/toolsGate.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class ToolSchemaMiddleware implements IContextMiddleware {
  readonly name = "ToolSchemaMiddleware";
  readonly priority = 40;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, runtimeType } = ctx;

    const requiresTools = ["agentic", "coding", "research", "swarm"].includes(runtimeType);
    if (!requiresTools) return;

    const allowedToolIds = await skillsGate.getResolvedToolsForAgent(agent.id);
    const compiledTools: any[] = [];
    const xmlToolDescriptions: string[] = [];

    for (const toolId of allowedToolIds) {
      const tool = toolsGate.get(toolId);
      if (!tool) continue;

      compiledTools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      });

      xmlToolDescriptions.push(`- Tool: \`${tool.name}\`\n  Description: ${tool.description}\n  Parameters: ${JSON.stringify(tool.parameters)}`);
    }

    packet.tools = compiledTools;

    if (xmlToolDescriptions.length > 0) {
      const reactPrompt = `[TOOL CALLING PROTOCOL]
You have access to the following tools:
${xmlToolDescriptions.join("\n\n")}

To call a tool, output an XML tag formatted exactly like this:
<call_tool name="tool_name">
{"arg1": "value1"}
</call_tool>

When you are ready to conclude and deliver your final answer to the user, output:
&&FINAL_RESPONSE&&
followed by your final response text.`;

      packet.systemPromptBlocks.push({
        id: "tool_schemas",
        priority: 40,
        content: reactPrompt,
      });
    }
  }
}
