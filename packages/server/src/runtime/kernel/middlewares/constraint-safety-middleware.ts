import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";
import { moduleGate } from "../../../modules/module-gate.js";
import { SOURCE_INTEGRITY_POINTER } from "./identity-authority-middleware.js";

export class ConstraintSafetyMiddleware implements IContextMiddleware {
  readonly name = "ConstraintSafetyMiddleware";
  readonly priority = 10;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent } = ctx;
    const safetyRules: string[] = [
      "Strict Invariant: You are prohibited from accessing or disclosing .env, credentials, or core server files.",
      "Strict Invariant: You must not execute unwhitelisted destructive commands.",
      "Operational Rule: Never fabricate tool outputs; inspect actual outputs returned by tools.",
      SOURCE_INTEGRITY_POINTER,
      "Lock Discipline: When locked in via lock_in, you are in isolated SELF-only view; do NOT hallucinate other agents' presence. When locked out, respect full roster visibility.",
    ];

    if (agent.constraintsModuleId) {
      const mod = await moduleGate.constraints.get(agent.constraintsModuleId, ctx.workspaceId);
      if (mod?.disallowedActions && Array.isArray(mod.disallowedActions)) {
        for (const action of mod.disallowedActions) {
          safetyRules.push(`Disallowed Action: ${action}`);
        }
      }
    }

    packet.systemPromptBlocks.push({
      id: "safety_constraints",
      priority: 10,
      content: `[SAFETY INVARIANTS & CONSTRAINTS]\n${safetyRules.map(r => `- ${r}`).join("\n")}`,
    });
  }
}
