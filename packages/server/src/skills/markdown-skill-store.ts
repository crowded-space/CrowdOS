// §20 Markdown skill store — discovery-first, lazily expanded.
//
// Canon (mock-structure-polished): skills live inside the owning workspace:
//
//   <workspaceFolder>/vfs/.crowdos/skills/<slug>.md
//
// resolved through the same per-workspace store root as every other local tier.
//
// The two properties this module exists to provide:
//
//   DISCOVERY (listSummaries)  — id/name/description/category only. No bodies.
//                                 This is what replaces wholesale prompt
//                                 injection: the agent learns a skill EXISTS
//                                 for one line of tokens.
//   EXPANSION (getSkill)       — the full Markdown body, fetched only for the
//                                 skills actually needed this turn.
//
// A skill file that fails to parse is SKIPPED and reported (never thrown): a
// typo in one Markdown file must not be able to break context assembly.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { resolveLocalStoreDir, searchableWorkspaceScopes } from "../shared/core/local-file.js";
import { parseMarkdownSkill } from "./markdown-skill-parser.js";
import type { MarkdownSkill, SkillSummary, SkillLoadReport } from "./markdown-skill-types.js";

export type { SkillLoadReport };

function skillsDir(workspaceId?: string | null): string {
  return join(resolveLocalStoreDir(workspaceId), "skills");
}

/** Parse every .md file in one directory. Never throws. */
async function loadDir(dir: string): Promise<{ skills: MarkdownSkill[]; errors: string[] }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { skills: [], errors: [] };
    return { skills: [], errors: [dir + ": " + (err?.message ?? String(err))] };
  }

  const skills: MarkdownSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const name of entries.sort()) {
    if (!/\.md$/i.test(name)) continue;
    const full = join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch (err: any) {
      errors.push(full + ": " + (err?.message ?? String(err)));
      continue;
    }
    const parsed = parseMarkdownSkill(raw, full);
    if (!parsed.skill) {
      if (parsed.error) errors.push(parsed.error);
      continue;
    }
    // First file wins on duplicate ids, deterministically (files are sorted).
    if (seen.has(parsed.skill.id)) {
      errors.push(full + ': duplicate skill id "' + parsed.skill.id + '" ignored');
      continue;
    }
    seen.add(parsed.skill.id);
    skills.push(parsed.skill);
  }

  return { skills, errors };
}

/**
 * Load and parse every skill file. Never throws: an unreadable directory is an
 * empty skill set, which is the honest answer for a workspace with no skills.
 *
 * Without a workspace id, every registered workspace is merged (first wins on a
 * duplicate id, in registry order) — the same rule the directory scan uses.
 */
export async function loadSkills(workspaceId?: string | null): Promise<SkillLoadReport> {
  const scopes: Array<string | null> = workspaceId && workspaceId.trim()
    ? [workspaceId]
    : searchableWorkspaceScopes();
  const skills: MarkdownSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const report = await loadDir(skillsDir(scope));
    errors.push(...report.errors);
    for (const skill of report.skills) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
    }
  }
  return { skills, errors };
}

/** Only the enabled skills — the set the system offers to agents. */
export async function loadEnabledSkills(workspaceId?: string | null): Promise<SkillLoadReport> {
  const report = await loadSkills(workspaceId);
  return { skills: report.skills.filter((s) => s.enabled), errors: report.errors };
}

/**
 * Discovery view (§20 "discoverable"): one line per skill, no Markdown body.
 *
 * filter narrows by category/topic so a caller can surface only the slice a
 * runtime cares about, keeping the discovery payload small.
 */
export async function listSummaries(
  filter: {
    category?: string;
    topic?: string;
    limit?: number;
    workspaceId?: string | null;
  } = {},
): Promise<SkillSummary[]> {
  const { skills } = await loadEnabledSkills(filter.workspaceId);
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
  return skills
    .filter((s) => (filter.category ? s.category === filter.category : true))
    .filter((s) => (filter.topic ? s.topic === filter.topic : true))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      topic: s.topic,
    }));
}

/** Lazy expansion (§20 "expanded on demand"): one full skill by id. */
export async function getSkill(skillId: string, workspaceId?: string | null): Promise<MarkdownSkill | null> {
  if (!skillId) return null;
  const { skills } = await loadEnabledSkills(workspaceId);
  return skills.find((s) => s.id === skillId) ?? null;
}

/**
 * Compose several skills into one workflow body (§20 "Skills are composable").
 *
 * Returns the concatenated Markdown of every skill that resolved, in the order
 * requested, plus the ids that did not. Order is preserved because composition
 * order is semantically meaningful (a later skill may refine an earlier one).
 */
export async function composeSkills(
  skillIds: readonly string[],
  workspaceId?: string | null,
): Promise<{
  body: string;
  resolved: string[];
  missing: string[];
}> {
  const resolved: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];
  for (const id of skillIds) {
    const skill = await getSkill(id, workspaceId);
    if (!skill) {
      missing.push(id);
      continue;
    }
    resolved.push(skill.id);
    blocks.push(
      "## Skill: " + skill.name + " (" + skill.category + (skill.topic ? " / " + skill.topic : "") + ")\n\n" + skill.body,
    );
  }
  return { body: blocks.join("\n\n---\n\n"), resolved, missing };
}
