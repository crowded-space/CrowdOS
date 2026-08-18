import { skillsGate } from "../../../Skills/skillsGate.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class SkillContextMiddleware implements IContextMiddleware {
  readonly name = "SkillContextMiddleware";
  readonly priority = 30;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent } = ctx;
    const activeSkills = await skillsGate.getAgentSkills(agent.id);

    if (activeSkills.length === 0) return;

    const skillBlocks: string[] = [];

    for (const skill of activeSkills) {
      const parts: string[] = [`### Skill: ${skill.name} (${skill.category})`];
      if (skill.description) parts.push(skill.description);

      if (skill.promptLayer.systemPromptAdditions?.length > 0) {
        parts.push(`**Guidelines:**\n${skill.promptLayer.systemPromptAdditions.map(s => `- ${s}`).join('\n')}`);
      }

      if (skill.promptLayer.executionGuidelines?.length > 0) {
        parts.push(`**Procedures:**\n${skill.promptLayer.executionGuidelines.map(s => `- ${s}`).join('\n')}`);
      }

      if (skill.promptLayer.fewShotExamples && skill.promptLayer.fewShotExamples.length > 0) {
        parts.push(`**Examples:**`);
        for (const ex of skill.promptLayer.fewShotExamples) {
          parts.push(`- Scenario: ${ex.scenario}\n  Reasoning: ${ex.thoughtProcess}\n  Outcome: ${ex.expectedOutcome}`);
        }
      }

      skillBlocks.push(parts.join('\n'));
    }

    packet.systemPromptBlocks.push({
      id: "active_skills",
      priority: 30,
      content: `[ACTIVE SPECIALIZED SKILLS]\n${skillBlocks.join('\n\n')}`,
    });
  }
}
