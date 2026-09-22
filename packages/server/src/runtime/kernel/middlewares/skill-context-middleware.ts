import { skillsGate } from "../../../skills/skills-gate.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

/**
 * §20 Skills, discovery-first.
 *
 * WHAT CHANGED AND WHY: this middleware used to push every active skill’s FULL
 * prompt layer into EVERY turn. §20 is explicit that skills "are intended to be
 * discoverable and expanded on demand rather than fully injected into every
 * context" — wholesale injection is exactly the context pollution and token
 * cost the document is trying to avoid.
 *
 * Now:
 *   * A skill with NO trigger always lands in its full form. These are the
 *     agent’s baseline specializations — the ones it is expected to apply
 *     without being asked, so gating them behind a discovery step would be a
 *     behavior regression rather than an economy.
 *   * A skill WITH a trigger is reduced to a ONE-LINE discovery entry (name +
 *     description + how to expand). Its body is only pulled in when the trigger
 *     matches the user input, or when the agent explicitly expands it via
 *     `load_skill`.
 *
 * Triggers are matched lexically against the user input — deliberately simple
 * and inspectable, consistent with the Interpreter’s "no heavy reasoning" rule
 * (§24). Trigger matching must never be the reason a run is slow or opaque.
 */
export class SkillContextMiddleware implements IContextMiddleware {
  readonly name = "SkillContextMiddleware";
  readonly priority = 30;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    // Canon: skills live inside the workspace folder, so discovery is scoped to
    // the workspace this turn belongs to — not a cross-workspace union.
    const { agent, userInput, workspaceId } = ctx;

    const alwaysOn: string[] = [];
    const deferred: string[] = [];

    // ── DB-backed skills (assigned to the agent) ──────────────────
    // Assigned skills carry no trigger model, so they keep their full form:
    // they are an explicit grant, and silently deferring a granted skill would
    // change agent behavior rather than save tokens.
    try {
      const activeSkills = await skillsGate.getAgentSkills(agent.id);
      for (const skill of activeSkills) {
        const parts: string[] = [`### Skill: ${skill.name} (${skill.category})`];
        if (skill.description) parts.push(skill.description);

        if (skill.promptLayer.systemPromptAdditions?.length > 0) {
          parts.push("**Guidelines:**\n" + skill.promptLayer.systemPromptAdditions.map((s) => `- ${s}`).join("\n"));
        }
        if (skill.promptLayer.executionGuidelines?.length > 0) {
          parts.push("**Procedures:**\n" + skill.promptLayer.executionGuidelines.map((s) => `- ${s}`).join("\n"));
        }
        if (skill.promptLayer.fewShotExamples && skill.promptLayer.fewShotExamples.length > 0) {
          parts.push("**Examples:**");
          for (const ex of skill.promptLayer.fewShotExamples) {
            parts.push(`- Scenario: ${ex.scenario}\n  Reasoning: ${ex.thoughtProcess}\n  Outcome: ${ex.expectedOutcome}`);
          }
        }
        alwaysOn.push(parts.join("\n"));
      }
    } catch {
      // No PG / no roster: Markdown skills below still apply.
    }

    // ── Markdown skills (§17/§20: files on disk) ────────────────
    // Discovery-first: a skill whose trigger does NOT appear in the user input
    // is advertised as one line and expanded only on demand.
    try {
      const summaries = await skillsGate.listMarkdownSummaries({ workspaceId: workspaceId ?? null });
      for (const summary of summaries) {
        const triggers = this.triggersFor(summary);
        if (triggers.length > 0 && this.matches(triggers, userInput)) {
          const skill = await skillsGate.getMarkdownSkill(summary.id, workspaceId ?? null);
          if (skill) alwaysOn.push(`### Skill: ${skill.name} (${skill.category})\n\n${skill.body}`);
          continue;
        }
        deferred.push(`- ${summary.name} [${summary.id}] (${summary.category}): ${summary.description}`);
      }
    } catch {
      // A skills directory that cannot be read is an empty skill set.
    }

    const blocks: string[] = [];
    if (alwaysOn.length > 0) {
      blocks.push("[ACTIVE SPECIALIZED SKILLS]\n" + alwaysOn.join("\n\n"));
    }
    if (deferred.length > 0) {
      blocks.push(
        "[AVAILABLE SKILLS - expand on demand]\n" +
          "These skills are installed but NOT loaded into context. Call load_skill with a " +
          "skill_id to expand one when it is relevant to the task.\n" +
          deferred.join("\n"),
      );
    }
    if (blocks.length === 0) return;

    packet.systemPromptBlocks.push({
      id: "active_skills",
      priority: 30,
      content: blocks.join("\n\n"),
    });
  }

  /**
   * Trigger words for a skill. The §20 format has no explicit trigger field,
   * so one is derived from the skill’s own identity (name + topic), which is
   * stable and needs no extra authoring burden.
   */
  private triggersFor(summary: { name: string; topic?: string }): string[] {
    const words = new Set<string>();
    for (const source of [summary.name, summary.topic ?? ""]) {
      for (const w of source.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length >= 4) words.add(w);
      }
    }
    return [...words];
  }

  /** Lexical trigger match against the user input. Never throws. */
  private matches(triggers: readonly string[], userInput: string): boolean {
    if (!userInput) return false;
    const haystack = userInput.toLowerCase();
    return triggers.some((t) => haystack.includes(t));
  }
}

