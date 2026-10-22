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

/**
 * Local-tier instruction content, in the same order the PG path uses: the
 * agent's stack links by ascending priorityOrder, and the profile's single
 * instruction module only when the agent has no stack links at all.
 *
 * Runtime overrides are applied with the PG path's exact semantics (mirrored
 * below): a scoped `replace` swaps ONE module's slice, a `replace` without a
 * target is refused (never a whole-stack wipe), a `replace` for a module that
 * is not in the stack is a no-op, `append` lines land after the rebuilt stack
 * in override-id order, and an expired override is never applied (the store
 * filters it out) and is swept from disk afterwards.
 */
async function collectLocalInstructions(ctx: ContextBuildContext): Promise<string[]> {
  const { agent } = ctx;
  const workspaceId = ctx.workspaceId;
  const { agentGate } = await import("../../../agents/agent-gate.js");
  const { moduleGate } = await import("../../../modules/module-gate.js");

  const links = (await agentGate
    .getInstructionStack(agent.id, undefined, workspaceId)
    .catch(() => [] as any[])) as Array<{
    instructionModuleId: string;
    instructionModule?: { base?: string[] } | null;
  }>;

  // Per-module content, so a scoped replace can swap ONE module's slice
  // (same map the PG path builds).
  const moduleContents = new Map<string, string[]>();
  let singleModuleId: string | null = null;

  if (links.length > 0) {
    for (const link of links) {
      const base =
        link.instructionModule?.base ??
        (await moduleGate.instruction.get(link.instructionModuleId, workspaceId).catch(() => null))?.base ??
        [];
      moduleContents.set(link.instructionModuleId, [...base]);
    }
  } else if (agent.instructionModuleId) {
    const mod = await moduleGate.instruction.get(agent.instructionModuleId, workspaceId).catch(() => null);
    if (mod?.base) {
      singleModuleId = mod.id;
      moduleContents.set(mod.id, [...mod.base]);
    }
  }

  // Active runtime overrides (expired ones are already filtered out by the
  // store) — deterministic order by override id.
  const overrides = (await agentGate
    .listLocalRuntimeOverrides(agent.id, workspaceId)
    .catch(() => [] as any[])) as Array<{
    id: string;
    instructionPatch?: InstructionPatch | null;
  }>;

  const pendingAppends: string[][] = [];
  for (const ov of overrides) {
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
      }
      // Target not in the current stack, or no target at all: no-op. A
      // whole-stack replace stays disallowed (nondeterministic wipe).
    }
  }

  // Rebuild from possibly-replaced module contents (deterministic stack order)
  const instructions: string[] = [];
  if (links.length > 0) {
    for (const link of links) {
      const content = moduleContents.get(link.instructionModuleId);
      if (content) instructions.push(...content);
    }
  } else if (singleModuleId) {
    const content = moduleContents.get(singleModuleId);
    if (content) instructions.push(...content);
  }
  // Preserve pending appends in deterministic override-id order
  for (const ap of pendingAppends) instructions.push(...ap);

  // Expiry deletion sweep: remove the expired local patches
  try {
    await agentGate.sweepExpiredLocalRuntimeOverrides(agent.id, workspaceId);
  } catch (err) {
    console.error("[InstructionStackMiddleware] local expiry sweep failed", err);
  }

  return instructions;
}

export class InstructionStackMiddleware implements IContextMiddleware {
  readonly name = "InstructionStackMiddleware";
  readonly priority = 15;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    // ponytail: degrade like history-compression — local-first runs have no DATABASE_URL
    let db: ReturnType<typeof getDb>;
    try {
      db = getDb();
    } catch {
      // Local tier: the instruction stack lives in the workspace's local store
      // (instruction-stacks.json + instruction-modules.json), so read it through
      // the same gates the Studio manifest path uses. Returning silently here
      // would drop the agent's operating instructions from the prompt entirely
      // for every local-first workspace.
      const local = await collectLocalInstructions(ctx);
      if (local.length > 0) {
        packet.systemPromptBlocks.push({
          id: "instruction_stack",
          priority: 15,
          content: `[OPERATING INSTRUCTIONS]\n${local.join("\n")}`,
        });
      }
      return;
    }
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
