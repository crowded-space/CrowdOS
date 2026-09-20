// §20 Markdown skill parser: front-matter + body, no dependencies.
//
// Format (`skills/<slug>.md`):
//
//   ---
//   id: debugging
//   name: Debugging
//   category: cognitive
//   topic: root-cause-analysis
//   description: One line, shown during discovery.
//   tools: read_file, execute_bash
//   workflowPattern: react
//   enabled: true
//   ---
//   ## Procedure
//   ...markdown body, expanded only on demand...
//
// Design rules:
//   * Hand-rolled front-matter (scalars + comma lists). A skill file must never
//     be able to crash discovery, and pulling a YAML dependency into the hot
//     path for eight scalar keys is not worth it.
//   * PARSE FAILURES ARE VALUES, NOT THROWS. A malformed skill is skipped with a
//     reported reason; it must never take down context assembly.
//   * An unknown `category` is a parse error — §20 defines a closed taxonomy, and
//     silently coercing would let a typo quietly disable the taxonomy.

import type { SkillCategory, MarkdownSkill, SkillParseResult } from "./markdown-skill-types.js";
import { SKILL_CATEGORIES } from "./markdown-skill-types.js";
import type { SkillWorkflowPattern } from "./skill-types.js";

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WORKFLOW_PATTERNS: readonly SkillWorkflowPattern[] = ["react", "plan_execute", "evaluator_optimizer"];

function isCategory(value: string): value is SkillCategory {
  return (SKILL_CATEGORIES as readonly string[]).includes(value);
}

function isWorkflowPattern(value: string): value is SkillWorkflowPattern {
  return (WORKFLOW_PATTERNS as readonly string[]).includes(value);
}

/** Strip surrounding quotes a hand-written front-matter value may carry. */
function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function parseList(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  // Accept both `[a, b]` and bare `a, b` forms.
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  return inner
    .split(",")
    .map((s) => unquote(s))
    .filter(Boolean);
}

function parseScalarFrontMatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    const value = trimmed.slice(sep + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Slugify a filename into a stable id fallback. */
function slugFromPath(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "skill";
  return base.replace(/\.md$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

/**
 * Parse one skill file. Never throws — an unusable file yields
 * `{ skill: null, error }` so the caller can report and skip it.
 */
export function parseMarkdownSkill(raw: string, filePath: string): SkillParseResult {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const match = FRONT_MATTER_RE.exec(text);
  if (!match) {
    return { skill: null, error: `${filePath}: missing front-matter block (--- ... ---)` };
  }
  const fm = parseScalarFrontMatter(match[1]);
  const body = text.slice(match[0].length).trim();

  const categoryRaw = (fm.category ?? "").toLowerCase();
  if (!isCategory(categoryRaw)) {
    return {
      skill: null,
      error: `${filePath}: category must be one of ${SKILL_CATEGORIES.join(", ")} (got "${fm.category ?? ""}")`,
    };
  }

  const id = unquote(fm.id ?? "") || slugFromPath(filePath);
  const name = unquote(fm.name ?? "") || id;
  const description = unquote(fm.description ?? "");
  const topic = unquote(fm.topic ?? "") || undefined;
  const workflowRaw = unquote(fm.workflowpattern ?? fm["workflow-pattern"] ?? "").toLowerCase();

  let workflowPattern: SkillWorkflowPattern | undefined;
  if (workflowRaw) {
    if (!isWorkflowPattern(workflowRaw)) {
      return {
        skill: null,
        error: `${filePath}: workflowPattern must be one of ${WORKFLOW_PATTERNS.join(", ")} (got "${workflowRaw}")`,
      };
    }
    workflowPattern = workflowRaw;
  }

  // enabled defaults to true; an explicit falsy value opts the skill out.
  const enabledRaw = unquote(fm.enabled ?? "").toLowerCase();
  const enabled = !(enabledRaw === "false" || enabledRaw === "no" || enabledRaw === "0");

  return {
    skill: {
      id,
      name,
      description,
      category: categoryRaw,
      topic,
      tools: parseList(fm.tools ?? ""),
      workflowPattern,
      enabled,
      body,
      path: filePath,
    },
  };
}

