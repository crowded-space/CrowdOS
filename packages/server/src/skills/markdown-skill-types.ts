// CrowdOS §20 — Skills: reusable cognitive / workflow specialization.
//
// A Skill is NOT a Tool and NOT a Runtime. It is a knowledge package / workflow
// pattern / orchestration preset / reasoning behavior, and per §17 it is
// persisted as MARKDOWN on disk (the document names Markdown as a first-class
// format for Skills and Instructions; JSON is for config/state).
//
// The §20 taxonomy is enforced here as a closed set:
//   cognitive   — reasoning specializations (architecture review, debugging,
//                 strategic planning, root cause analysis, threat modeling)
//   operational — execution-oriented workflows (frontend, backend, refactoring,
//                 data pipelines, research)
//   swarm       — multi-agent coordination patterns (data/research/review/
//                 coding swarm)
//
// Skills are COMPOSABLE (§20): a set of skills forms a dynamically assembled
// workflow, so nothing here implies a single active skill.

import type { SkillWorkflowPattern } from "./skill-types.js";

/** The §20 taxonomy. Closed set — an unknown category is not a skill. */
export type SkillCategory = "cognitive" | "operational" | "swarm";

export const SKILL_CATEGORIES: readonly SkillCategory[] = ["cognitive", "operational", "swarm"] as const;

/**
 * A Skill parsed from `skills/<slug>.md`.
 *
 * `body` is the Markdown content after the front-matter — the expandable
 * payload. It is NOT injected on discovery (§20: "discoverable and expanded on
 * demand rather than fully injected into every context").
 */
export interface MarkdownSkill {
  /** Front-matter `id`, or the filename slug when absent. */
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  /** Optional sub-classification within a category, e.g. "debugging". */
  topic?: string;
  /** Registry tool ids this skill expects. Advisory for discovery. */
  tools: string[];
  workflowPattern?: SkillWorkflowPattern;
  /** True when the skill is offered for on-demand expansion. */
  enabled: boolean;
  /** Markdown body (the expandable prompt layer). Capped at MAX_SKILL_BODY_CHARS. */
  body: string;
  /** True when body was truncated to the cap. */
  truncated?: boolean;
  /** Absolute path of the source file — diagnostics and edit flows. */
  path: string;
}

/** Discovery-first view: one line, no body. This is what rides on the packet. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  topic?: string;
}

/** Result of parsing one file — malformed skills are reported, never thrown. */
export interface SkillParseResult {
  skill: MarkdownSkill | null;
  /** Populated when the file could not be parsed; the file is then skipped. */
  error?: string;
}

/** Result of loading a skills directory: usable skills plus per-file errors. */
export interface SkillLoadReport {
  skills: MarkdownSkill[];
  errors: string[];
}
