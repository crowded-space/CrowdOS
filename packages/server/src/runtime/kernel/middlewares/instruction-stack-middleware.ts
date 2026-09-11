import { eq, and, asc, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/config/database.js";
import { agentInstructionStacks, instructionModules, runtimeOverrides } from "../../../db/schema.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

type InstructionPatch = {
  append?: string[];
  replace?: string[];
  targetModuleId?: string;
  replaceTarget?: string;
};

export class InstructionStackMiddleware implements IContextMiddleware {
  readonly name = "InstructionStackMiddleware";
  readonly priority = 15;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const db = getDb();
    const { agent } = ctx;
    const instructions: string[] = [];

    // 1. Check for composed instruction stack — deterministic orderBy(id) added for CTX-2
    const stackLinks = await db.query.agentInstructionStacks.findMany({
      where: and(
        eq(agentInstructionStacks.agentId, agent.id),
        eq(agentInstructionStacks.isEnabled, true)
      ),
      orderBy: [asc(agentInstructionStacks.priorityOrder), asc(agentInstructionStacks.id)],
      with: {
        instructionModule: true,
      },
    });

    // Track per-module content for scoped replace (CTX-2: replace wipes only target module, not whole stack)
    const moduleContents = new Map<string, string[]>();
    let singleModule: { id: string; base: string[] } | null = null;
    if (stackLinks.length > 0) {
      for (const link of stackLinks) {
        const base = link.instructionModule?.base ?? [];
        moduleContents.set(link.instructionModuleId, [...base]);
        instructions.push(...base);
      }
    } else if (agent.instructionModuleId) {
      // Fallback to legacy single instruction module
      const mod = await db.query.instructionModules.findFirst({
        where: eq(instructionModules.id, agent.instructionModuleId),
      });
      if (mod?.base) {
        singleModule = { id: mod.id, base: [...mod.base] };
        moduleContents.set(mod.id, [...mod.base]);
        instructions.push(...mod.base);
      }
    }

    // 2. Apply active runtime overrides — deterministic orderBy(id)
    const activeOverrides = await db.query.runtimeOverrides.findMany({
      where: eq(runtimeOverrides.targetAgentId, agent.id),
      orderBy: [asc(runtimeOverrides.id)],
    });

    const now = new Date();
    const expiredIds: string[] = [];
    const pendingAppends: string[][] = [];
    for (const ov of activeOverrides) {
      if (ov.expiresAt && new Date(ov.expiresAt) < now) {
        expiredIds.push(ov.id);
        continue;
      }
      if (!ov.instructionPatch) continue;
      const patch = ov.instructionPatch as InstructionPatch;
      if (Array.isArray(patch.append)) {
        pendingAppends.push([...patch.append]);
      }
      if (Array.isArray(patch.replace)) {
        const targetId = patch.targetModuleId ?? patch.replaceTarget;
        if (targetId && moduleContents.has(targetId)) {
          // Scoped replace: replace only the target module's slice
          moduleContents.set(targetId, [...patch.replace]);
        } else if (targetId) {
          // Target not in current stack — create entry so replace is not lost, but will be appended in order
          // For determinism, treat unknown target as no-op (do not wipe whole stack)
          continue;
        } else {
          // Legacy whole-stack replace without target is disallowed (nondeterministic wipe) — skip
          continue;
        }
      }
    }

    // Rebuild instructions from possibly-replaced module contents (deterministic stack order)
    if (moduleContents.size > 0) {
      const rebuilt: string[] = [];
      if (stackLinks.length > 0) {
        for (const link of stackLinks) {
          const content = moduleContents.get(link.instructionModuleId);
          if (content) rebuilt.push(...content);
        }
      } else if (singleModule) {
        const content = moduleContents.get(singleModule.id);
        if (content) rebuilt.push(...content);
      }
      // Preserve pending appends in deterministic override-id order
      for (const ap of pendingAppends) rebuilt.push(...ap);
      instructions.length = 0;
      instructions.push(...rebuilt);
    } else {
      // No modules, just appends
      for (const ap of pendingAppends) instructions.push(...ap);
    }

    // Expiry deletion sweep: remove expired patches
    if (expiredIds.length > 0) {
      try {
        await db.delete(runtimeOverrides).where(inArray(runtimeOverrides.id, expiredIds));
      } catch (err) {
        console.error("[InstructionStackMiddleware] expiry sweep failed", err);
      }
    }

    if (instructions.length > 0) {
      packet.systemPromptBlocks.push({
        id: "instruction_stack",
        priority: 15,
        content: `[OPERATING INSTRUCTIONS]\n${instructions.join("\n")}`,
      });
    }
  }
}
