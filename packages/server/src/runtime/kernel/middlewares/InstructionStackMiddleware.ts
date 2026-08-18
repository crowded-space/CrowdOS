import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../../../Shared/config/database.js";
import { agentInstructionStacks, instructionModules, runtimeOverrides } from "../../../db/schema.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class InstructionStackMiddleware implements IContextMiddleware {
  readonly name = "InstructionStackMiddleware";
  readonly priority = 20;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const db = getDb();
    const { agent } = ctx;
    const instructions: string[] = [];

    // 1. Check for composed instruction stack
    const stackLinks = await db.query.agentInstructionStacks.findMany({
      where: and(
        eq(agentInstructionStacks.agentId, agent.id),
        eq(agentInstructionStacks.isEnabled, true)
      ),
      orderBy: [asc(agentInstructionStacks.priorityOrder)],
      with: {
        instructionModule: true,
      },
    });

    if (stackLinks.length > 0) {
      for (const link of stackLinks) {
        if (link.instructionModule?.base) {
          instructions.push(...link.instructionModule.base);
        }
      }
    } else if (agent.instructionModuleId) {
      // Fallback to legacy single instruction module
      const singleModule = await db.query.instructionModules.findFirst({
        where: eq(instructionModules.id, agent.instructionModuleId),
      });
      if (singleModule?.base) {
        instructions.push(...singleModule.base);
      }
    }

    // 2. Apply active runtime overrides
    const activeOverrides = await db.query.runtimeOverrides.findMany({
      where: eq(runtimeOverrides.targetAgentId, agent.id),
    });

    for (const ov of activeOverrides) {
      if (ov.expiresAt && new Date(ov.expiresAt) < new Date()) continue;
      if (ov.instructionPatch) {
        const patch = ov.instructionPatch as { append?: string[]; replace?: string[] };
        if (Array.isArray(patch.append)) {
          instructions.push(...patch.append);
        }
        if (Array.isArray(patch.replace)) {
          instructions.length = 0;
          instructions.push(...patch.replace);
        }
      }
    }

    if (instructions.length > 0) {
      packet.systemPromptBlocks.push({
        id: "instruction_stack",
        priority: 20,
        content: `[OPERATING INSTRUCTIONS]\n${instructions.join("\n")}`,
      });
    }
  }
}
