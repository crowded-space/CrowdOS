import { eq } from "drizzle-orm";
import { getDb } from "../../../Shared/config/database.js";
import { constraintsModules } from "../../../db/schema.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class ConstraintSafetyMiddleware implements IContextMiddleware {
  readonly name = "ConstraintSafetyMiddleware";
  readonly priority = 50;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent } = ctx;
    const safetyRules: string[] = [
      "Strict Invariant: You are prohibited from accessing or disclosing .env, credentials, or core server files.",
      "Strict Invariant: You must not execute unwhitelisted destructive commands.",
      "Operational Rule: Never fabricate tool outputs; inspect actual outputs returned by tools.",
    ];

    if (agent.constraintsModuleId) {
      const db = getDb();
      const mod = await db.query.constraintsModules.findFirst({
        where: eq(constraintsModules.id, agent.constraintsModuleId),
      });
      if (mod?.disallowedActions && Array.isArray(mod.disallowedActions)) {
        for (const action of mod.disallowedActions) {
          safetyRules.push(`Disallowed Action: ${action}`);
        }
      }
    }

    packet.systemPromptBlocks.push({
      id: "safety_constraints",
      priority: 50,
      content: `[SAFETY INVARIANTS & CONSTRAINTS]\n${safetyRules.map(r => `- ${r}`).join("\n")}`,
    });
  }
}
