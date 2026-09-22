// CrowdOS §20 — Skills as Markdown: discovery-first, lazily expanded.
//
// The audit found skills implemented as PG rows whose FULL prompt layer was
// injected into every turn, with no Markdown persistence and no taxonomy
// enforcement. These tests pin the corrected behavior:
//
//   * Markdown on disk is the §17 persistence rule for Skills.
//   * The §20 taxonomy (cognitive / operational / swarm) is CLOSED — an unknown
//     category is a parse error, not a silent coercion.
//   * Discovery returns one line per skill and NO body.
//   * Expansion is explicit, per-skill, and composable.
//   * A malformed file is skipped with a reported reason — it can never throw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { parseMarkdownSkill } from "./markdown-skill-parser.js";
import {
  loadSkills,
  loadEnabledSkills,
  listSummaries,
  getSkill,
  composeSkills,
} from "./markdown-skill-store.js";

let dir: string;

function skillFile(slug: string, content: string): void {
  // Canon: skills live at <workspaceFolder>/vfs/.crowdos/skills/. The unscoped
  // default workspace is the folder these tests write into.
  const skillsDir = join(localStoreDirsForTests().crowdos, "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, `${slug}.md`), content, "utf8");
}

const DEBUGGING_MD = [
  "---",
  "id: debugging",
  "name: Debugging",
  "category: cognitive",
  "topic: root-cause-analysis",
  "description: Systematically isolate a defect before proposing a fix.",
  "tools: read_file, execute_bash",
  "workflowPattern: react",
  "---",
  "## Procedure",
  "1. Reproduce. 2. Bisect. 3. Confirm the root cause.",
  "",
  "BODY_MARKER_SHOULD_NOT_APPEAR_IN_DISCOVERY",
  "",
].join("\n");

const FRONTEND_MD = [
  "---",
  "id: frontend",
  "name: Frontend",
  "category: operational",
  "description: Build and refine user interfaces.",
  "---",
  "Frontend body.",
  "",
].join("\n");

const SWARM_MD = [
  "---",
  "id: review-swarm",
  "name: Review Swarm",
  "category: swarm",
  "description: Fan a review out across several agents and aggregate.",
  "---",
  "Swarm body.",
  "",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-skills-"));
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("§20 front-matter parsing", () => {
  it("parses a well-formed skill", () => {
    const { skill, error } = parseMarkdownSkill(DEBUGGING_MD, "/ws/skills/debugging.md");
    expect(error).toBeUndefined();
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe("debugging");
    expect(skill!.name).toBe("Debugging");
    expect(skill!.category).toBe("cognitive");
    expect(skill!.topic).toBe("root-cause-analysis");
    expect(skill!.tools).toEqual(["read_file", "execute_bash"]);
    expect(skill!.workflowPattern).toBe("react");
    expect(skill!.enabled).toBe(true);
    expect(skill!.body).toContain("BODY_MARKER_SHOULD_NOT_APPEAR_IN_DISCOVERY");
  });

  it("accepts all three §20 categories", () => {
    for (const [md, expected] of [[DEBUGGING_MD, "cognitive"], [FRONTEND_MD, "operational"], [SWARM_MD, "swarm"]] as const) {
      const { skill } = parseMarkdownSkill(md, "/ws/skills/x.md");
      expect(skill!.category).toBe(expected);
    }
  });

  it("rejects a category outside the §20 taxonomy", () => {
    const bad = ["---", "name: X", "category: wizardry", "---", "body"].join("\n");
    const { skill, error } = parseMarkdownSkill(bad, "/ws/skills/bad.md");
    expect(skill).toBeNull();
    expect(error).toContain("category must be one of cognitive, operational, swarm");
  });

  it("rejects a file with no front-matter", () => {
    const { skill, error } = parseMarkdownSkill("# Just a heading\n", "/ws/skills/plain.md");
    expect(skill).toBeNull();
    expect(error).toContain("missing front-matter");
  });

  it("rejects an unknown workflowPattern rather than guessing", () => {
    const bad = ["---", "name: X", "category: cognitive", "workflowPattern: telepathy", "---", "b"].join("\n");
    const { skill, error } = parseMarkdownSkill(bad, "/ws/skills/w.md");
    expect(skill).toBeNull();
    expect(error).toContain("workflowPattern must be one of");
  });

  it("falls back to the filename slug when no id is given", () => {
    const { skill } = parseMarkdownSkill(["---", "name: Nameless", "category: cognitive", "---", "b"].join("\n"), "/ws/skills/my-skill.md");
    expect(skill!.id).toBe("my-skill");
  });

  it("honours enabled: false", () => {
    const md = ["---", "id: off", "name: Off", "category: cognitive", "enabled: false", "---", "b"].join("\n");
    expect(parseMarkdownSkill(md, "/ws/skills/off.md").skill!.enabled).toBe(false);
  });

  it("never throws on arbitrary garbage", () => {
    for (const junk of ["", "\uFEFF", "---\n", "---\n\n---\n", "\u0000\u0001", "---\ncategory: cognitive\n---\n"]) {
      expect(() => parseMarkdownSkill(junk, "/ws/skills/junk.md")).not.toThrow();
    }
  });
});

describe("§20 store: discovery without bodies", () => {
  it("loads every markdown skill in the directory", async () => {
    skillFile("debugging", DEBUGGING_MD);
    skillFile("frontend", FRONTEND_MD);
    skillFile("review-swarm", SWARM_MD);
    const report = await loadSkills();
    expect(report.errors).toEqual([]);
    expect(report.skills.map((s) => s.id).sort()).toEqual(["debugging", "frontend", "review-swarm"]);
  });

  it("returns an empty set for a workspace with no skills directory", async () => {
    const report = await loadSkills();
    expect(report).toEqual({ skills: [], errors: [] });
  });

  it("skips a malformed skill and reports it without failing the whole load", async () => {
    skillFile("good", FRONTEND_MD);
    skillFile("broken", "no front matter at all");
    skillFile("bad-category", ["---", "name: X", "category: nonsense", "---", "b"].join("\n"));
    const report = await loadSkills();
    expect(report.skills.map((s) => s.id)).toEqual(["frontend"]);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.join(" ")).toContain("missing front-matter");
    expect(report.errors.join(" ")).toContain("category must be one of");
  });

  it("excludes disabled skills from the enabled set", async () => {
    skillFile("on", FRONTEND_MD);
    skillFile("off", ["---", "id: off", "name: Off", "category: cognitive", "enabled: false", "---", "b"].join("\n"));
    expect((await loadEnabledSkills()).skills.map((s) => s.id)).toEqual(["frontend"]);
  });

  it("discovery returns one line per skill and NO body (the token economy)", async () => {
    skillFile("debugging", DEBUGGING_MD);
    const summaries = await listSummaries();
    expect(summaries).toHaveLength(1);
    const keys = Object.keys(summaries[0]).sort();
    expect(keys).toEqual(["category", "description", "id", "name", "topic"]);
    // The body marker must not leak into the discovery view.
    expect(JSON.stringify(summaries)).not.toContain("BODY_MARKER_SHOULD_NOT_APPEAR_IN_DISCOVERY");
  });

  it("filters discovery by category and topic", async () => {
    skillFile("debugging", DEBUGGING_MD);
    skillFile("frontend", FRONTEND_MD);
    skillFile("review-swarm", SWARM_MD);
    expect((await listSummaries({ category: "swarm" })).map((s) => s.id)).toEqual(["review-swarm"]);
    expect((await listSummaries({ topic: "root-cause-analysis" })).map((s) => s.id)).toEqual(["debugging"]);
    expect(await listSummaries({ category: "planning" })).toEqual([]);
  });
});

describe("§20 lazy expansion and composition", () => {
  it("expands one skill to its full body on request", async () => {
    skillFile("debugging", DEBUGGING_MD);
    const skill = await getSkill("debugging");
    expect(skill).not.toBeNull();
    expect(skill!.body).toContain("BODY_MARKER_SHOULD_NOT_APPEAR_IN_DISCOVERY");
  });

  it("returns null for an unknown or disabled skill", async () => {
    skillFile("on", FRONTEND_MD);
    skillFile("off", ["---", "id: off", "name: Off", "category: cognitive", "enabled: false", "---", "b"].join("\n"));
    expect(await getSkill("nope")).toBeNull();
    expect(await getSkill("off")).toBeNull();
    expect(await getSkill("")).toBeNull();
  });

  it("composes several skills into one workflow, preserving request order", async () => {
    skillFile("debugging", DEBUGGING_MD);
    skillFile("frontend", FRONTEND_MD);
    const composed = await composeSkills(["frontend", "debugging"]);
    expect(composed.resolved).toEqual(["frontend", "debugging"]);
    expect(composed.missing).toEqual([]);
    // Order is semantically meaningful: the earlier skill must come first.
    expect(composed.body.indexOf("Frontend body.")).toBeLessThan(composed.body.indexOf("## Procedure"));
  });

  it("reports missing ids instead of failing a composition", async () => {
    skillFile("frontend", FRONTEND_MD);
    const composed = await composeSkills(["frontend", "ghost"]);
    expect(composed.resolved).toEqual(["frontend"]);
    expect(composed.missing).toEqual(["ghost"]);
    expect(composed.body).toContain("Frontend body.");
  });
});

