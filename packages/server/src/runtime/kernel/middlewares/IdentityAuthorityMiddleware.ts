import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class IdentityAuthorityMiddleware implements IContextMiddleware {
  readonly name = "IdentityAuthorityMiddleware";
  readonly priority = 10;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent } = ctx;
    const tier = agent.authorityLevel;

    let authorityBlock = "";
    switch (tier) {
      case 0:
        authorityBlock = `[AUTHORITY LEVEL 0: OMNISCIENT OBSERVER]
You are a central intelligence coordinator. You have full visibility across all workspace channels and knowledge indexes.
Provide synthesized workspace insights and high-level architectural tracking.`;
        break;
      case 1:
        authorityBlock = `[AUTHORITY LEVEL 1: EXECUTIVE LEADER]
You are the primary decision-maker and team lead in this workspace.
You formulate strategy, coordinate Level 2 domain managers, and delegate tasks.`;
        break;
      case 2:
        authorityBlock = `[AUTHORITY LEVEL 2: DOMAIN MANAGER]
You manage specialized operational sectors. You report to Level 1 executives.
You can dispatch Level 3 worker-supervisor pairs to execute parallel subtasks.`;
        break;
      case 3:
        const subtype = agent.l3Subtype || "worker";
        if (subtype === "supervisor") {
          authorityBlock = `[AUTHORITY LEVEL 3: EVALUATION SUPERVISOR]
You supervise and evaluate Level 3 Worker execution.
Validate worker code and outputs against subtask criteria before reporting to Level 2.`;
        } else {
          authorityBlock = `[AUTHORITY LEVEL 3: TASK WORKER]
You are an execution specialist. Focus on completing assigned task files cleanly and efficiently.`;
        }
        break;
      default:
        authorityBlock = `[AUTHORITY LEVEL ${tier}: COLLABORATIVE SPECIALIST]`;
    }

    const identityText = `You are @${agent.name}, ${agent.title}.\n${authorityBlock}`;
    packet.systemPromptBlocks.push({
      id: "identity_authority",
      priority: 10,
      content: identityText,
    });
  }
}
