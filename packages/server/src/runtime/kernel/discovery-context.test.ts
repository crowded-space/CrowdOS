// CrowdOS §20/§21 — the discovery/expansion contract as seen by the AGENT.
//
// The unit tests in the capabilities/ and skills/ domains prove the data layer.
// These tests prove the thing the objective actually cares about: that the
// assembled context no longer contains every skill body and every tool schema,
// and that the expansion verbs exist to pull them in on demand.
//
// Assertions are deliberately about PRESENCE/ABSENCE of payload markers in the
// final system prompt, because that is the token cost being optimized.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../../shared/core/local-file.js";
// IMPORT ORDER MATTERS: ToolSchemaMiddleware -> tools-gate -> tool-registry ->
// register-socket-server -> runtime-gate -> context-assembler is a real module
// cycle. Importing the pipeline manager first (exactly what production does)
// fully initializes the cycle before the middleware classes are resolved, so
// `new ToolSchemaMiddleware()` is constructible. Importing the middleware first
// yields a partially-initialized module. See the Capabilities domain spec Gaps.
import "./context-pipeline-manager.js";

let dir: string;

const BODY_MARKER = "SKILL_BODY_PAYLOAD_MARKER";

function writeSkill(slug: string, frontMatter: string[], body: string): void {
  const skillsDir = join(dir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, `${slug}.md`), [...frontMatter, body, ""].join("\n"), "utf8");
}

const AGENT: any = {
  id: "agent-skill-discovery",
  name: "DiscoveryBot",
  title: "Tester",
  authorityLevel: 3,
  species: "Crow",
  status: "idle",
  memorySharingPolicy: "full",
  modelModuleId: null,
  instructionModuleId: null,
  constraintsModuleId: null,
};

function makePacket(): any {
  return {
    systemPromptBlocks: [],
    metadata: {},
    policies: { maxTokenBudget: 8000 },
    history: [],
    tools: [],
    userPrompt: "",
  };
}

function makeCtx(userInput: string): any {
  return {
    agent: AGENT,
    channelId: "chan-skill-discovery",
    workspaceId: "ws-skill-discovery",
    userInput,
    runtimeType: "agentic",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-skill-mw-"));
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("§20 SkillContextMiddleware defers un-triggered skill bodies", () => {
  it("advertises an installed skill as a one-line entry WITHOUT its body", async () => {
    writeSkill(
      "frontend",
      ["---", "id: frontend", "name: Frontend", "category: operational", "description: Build user interfaces.", "---"],
      BODY_MARKER,
    );
    const { SkillContextMiddleware } = await import("./middlewares/skill-context-middleware.js");
    const packet = makePacket();
    // Input deliberately does NOT mention the skill.
    await new SkillContextMiddleware().process(packet, makeCtx("what is the weather"));

    const content = packet.systemPromptBlocks.map((b: any) => b.content).join("\n");
    // Advertised...
    expect(content).toContain("AVAILABLE SKILLS");
    expect(content).toContain("frontend");
    expect(content).toContain("Build user interfaces.");
    // ...but the body was NOT injected. This is the whole point of §20.
    expect(content).not.toContain(BODY_MARKER);
  });

  it("expands the body inline when the trigger appears in the user input", async () => {
    writeSkill(
      "frontend",
      ["---", "id: frontend", "name: Frontend", "category: operational", "description: Build user interfaces.", "---"],
      BODY_MARKER,
    );
    const { SkillContextMiddleware } = await import("./middlewares/skill-context-middleware.js");
    const packet = makePacket();
    await new SkillContextMiddleware().process(packet, makeCtx("help me with the frontend build"));

    const content = packet.systemPromptBlocks.map((b: any) => b.content).join("\n");
    expect(content).toContain("ACTIVE SPECIALIZED SKILLS");
    expect(content).toContain(BODY_MARKER);
  });

  it("defers every installed skill when nothing triggers (cost scales with the task, not the install)", async () => {
    for (const slug of ["alpha", "beta", "gamma"]) {
      writeSkill(
        slug,
        ["---", `id: ${slug}`, `name: ${slug}`, "category: cognitive", `description: Skill ${slug}.`, "---"],
        `${BODY_MARKER}_${slug}`,
      );
    }
    const { SkillContextMiddleware } = await import("./middlewares/skill-context-middleware.js");
    const packet = makePacket();
    await new SkillContextMiddleware().process(packet, makeCtx("unrelated request"));

    const content = packet.systemPromptBlocks.map((b: any) => b.content).join("\n");
    for (const slug of ["alpha", "beta", "gamma"]) {
      expect(content).toContain(slug);
      expect(content).not.toContain(`${BODY_MARKER}_${slug}`);
    }
  });

  it("emits no skill block at all when no skills are installed", async () => {
    const { SkillContextMiddleware } = await import("./middlewares/skill-context-middleware.js");
    const packet = makePacket();
    await new SkillContextMiddleware().process(packet, makeCtx("hello"));
    expect(packet.systemPromptBlocks.find((b: any) => b.id === "active_skills")).toBeUndefined();
  });
});

describe("§21 ToolSchemaMiddleware advertises capabilities without expanding them", () => {
  it("attaches visibleCapabilities to the packet for a tool-capable runtime", async () => {
    const { ToolSchemaMiddleware } = await import("./middlewares/tool-schema-middleware.js");
    const packet = makePacket();
    await new ToolSchemaMiddleware().process(packet, makeCtx("do something"));
    // Always present (possibly empty) so the packet shape is stable §26.
    expect(Array.isArray(packet.visibleCapabilities)).toBe(true);
    for (const cap of packet.visibleCapabilities) {
      // Discovery carries no schemas — the token-economy contract.
      expect(Object.keys(cap).sort()).toEqual(["available", "domain", "id", "summary"]);
    }
  });

  it("leaves a conversational runtime with no tools but still sets the field", async () => {
    const { ToolSchemaMiddleware } = await import("./middlewares/tool-schema-middleware.js");
    const packet = makePacket();
    const ctx = { ...makeCtx("chat with me"), runtimeType: "conversational" as never };
    await new ToolSchemaMiddleware().process(packet, ctx);
    expect(packet.tools).toEqual([]);
    expect(Array.isArray(packet.visibleCapabilities)).toBe(true);
  });

  it("always injects the two expansion verbs for a tool-capable runtime", async () => {
    const { ToolSchemaMiddleware } = await import("./middlewares/tool-schema-middleware.js");
    const packet = makePacket();
    await new ToolSchemaMiddleware().process(packet, makeCtx("do something"));
    const names = packet.tools.map((t: any) => t.name);
    // Discovery without an expansion verb would be a dead end.
    expect(names).toContain("open_detail");
    expect(names).toContain("load_skill");
  });
});
