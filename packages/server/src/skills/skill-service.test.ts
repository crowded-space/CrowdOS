// DB half of the Skills domain: CRUD semantics, the partial-update merge
// contract (an omitted field must never be reset to a default), assignment
// cache invalidation, and the three-source tool resolution with its
// hardcoded universals. The DB layer is a scripted in-memory fake; drizzle
// where-clauses are interpreted from their Param/encoder structure so the
// real query-building code runs unmodified.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    skills: [] as Row[],
    agentSkills: [] as Row[],
    agent: null as Row | null,
    toolkit: null as Row | null,
    insertAgentSkillError: null as { code: string } | null,
    agentSkillFindMisses: 0,
    registryHidden: [] as string[],
    registryThrowFor: [] as string[],
    listCalls: [] as Array<{ where?: unknown; limit?: number }>,
    skillQueryCount: 0,
    linkQueryCount: 0,
    activeDb: null as any,
    dbScope: "test-scope",
  };

  const camel = (name: string) => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const tableName = (table: any): string => table?.[Symbol.for("drizzle:Name")] ?? "";

  function paramsOf(where: any): Array<{ col: string; value: unknown }> {
    const out: Array<{ col: string; value: unknown }> = [];
    const walk = (chunks: any[]) => {
      for (const c of chunks) {
        if (Array.isArray(c)) { walk(c); continue; }
        if (!c || typeof c !== "object") continue;
        if (c.constructor?.name === "Param") {
          out.push({ col: camel(String(c.encoder?.name ?? "")), value: c.value });
          continue;
        }
        if (Array.isArray(c.queryChunks)) walk(c.queryChunks);
      }
    };
    if (Array.isArray(where?.queryChunks)) walk(where.queryChunks);
    return out;
  }

  // The service only builds eq/and/inArray conditions — evaluate those.
  function callbackCond(table: any, where: (t: any, ops: any) => any, row: Row): boolean {
    const cond = where(table, {
      eq: (col: any, value: unknown) => ({ __eq: [camel(String(col)), value] }),
      inArray: (col: any, values: unknown[]) => ({ __in: [camel(String(col)), values] }),
      and: (...cs: any[]) => ({ __and: cs }),
    });
    const check = (c: any): boolean => {
      if (c === true || c === false) return c;
      if (c?.__eq) return row[c.__eq[0]] === c.__eq[1];
      if (c?.__in) return (c.__in[1] as unknown[]).includes(row[c.__in[0]]);
      if (c?.__and) return c.__and.every(check);
      return true;
    };
    return check(cond);
  }

  function matches(name: string, row: Row, where: any): boolean {
    if (!where) return true;
    if (typeof where === "function") {
      return callbackCond(name === "skills" ? { id: "id" } : { agentId: "agentId", skillId: "skillId" }, where, row);
    }
    return paramsOf(where).every((p) => row[p.col] === p.value);
  }

  const affected = (name: string, rows: Row[], where: any) => rows.filter((r) => matches(name, r, where));

  const db = {
    query: {
      skills: {
        findMany: async (opts: any) => {
          state.skillQueryCount++;
          state.listCalls.push({ where: opts?.where, limit: opts?.limit });
          return affected("skills", state.skills, opts?.where).slice(0, opts?.limit ?? undefined);
        },
        findFirst: async (opts: any) => affected("skills", state.skills, opts?.where)[0] ?? null,
      },
      agentSkills: {
        findMany: async (opts: any) => {
          state.linkQueryCount++;
          return affected("agent_skills", state.agentSkills, opts?.where);
        },
        findFirst: async (opts: any) => {
          if (state.agentSkillFindMisses > 0) { state.agentSkillFindMisses--; return null; }
          return affected("agent_skills", state.agentSkills, opts?.where)[0] ?? null;
        },
      },
      agents: {
        findFirst: async (opts: any) =>
          state.agent && matches("agents", state.agent, opts?.where) ? { ...state.agent } : null,
      },
      toolkitModules: {
        findFirst: async (opts: any) =>
          state.toolkit && matches("toolkit_modules", state.toolkit, opts?.where) ? { ...state.toolkit } : null,
      },
    },
    insert(table: any) {
      return {
        values(values: Row) {
          const commit = () => {
            const name = tableName(table);
            if (name === "agent_skills" && state.insertAgentSkillError) {
              const err = state.insertAgentSkillError;
              state.insertAgentSkillError = null;
              throw err;
            }
            const rec = { ...values };
            (name === "skills" ? state.skills : state.agentSkills).push(rec);
            return rec;
          };
          return {
            returning: async () => [commit()],
            then: (res: any, rej: any) => {
              try { return Promise.resolve(commit()).then(res, rej); }
              catch (err) { return Promise.reject(err).then(res, rej); }
            },
          };
        },
      };
    },
    update(table: any) {
      return {
        set(patch: Row) {
          const run = (where: any) => {
            const rows = affected(tableName(table), tableName(table) === "skills" ? state.skills : state.agentSkills, where);
            for (const row of rows) Object.assign(row, patch);
            return rows;
          };
          return {
            where: (where: any) => ({
              returning: async () => run(where),
              then: (res: any, rej: any) => { try { return Promise.resolve(run(where)).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
            }),
          };
        },
      };
    },
    delete(table: any) {
      return {
        where: (where: any) => {
          const run = (projection?: Record<string, any>) => {
            const name = tableName(table);
            const rows = name === "skills" ? state.skills : state.agentSkills;
            const hit = rows.filter((r) => matches(name, r, where));
            const survivors = rows.filter((r) => !matches(name, r, where));
            rows.length = 0;
            rows.push(...survivors);
            if (!projection) return hit;
            return hit.map((r) => Object.fromEntries(Object.keys(projection).map((k) => [k, r[k]])));
          };
          return {
            returning: async (projection?: Record<string, any>) => run(projection),
            then: (res: any, rej: any) => { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
          };
        },
      };
    },
  };

  // SK-002: split-DB fixture — a minimal tenant handle over its own row set,
  // mirroring the shape the service reads through getDb().
  function makeTenantDb(scope: string, rows: { agent: Row | null; toolkit: Row | null; agentSkills?: Row[]; skills?: Row[] }): any {
    return {
      __scope: scope,
      query: {
        agents: {
          findFirst: async (opts: any) => (rows.agent && matches("agents", rows.agent, opts?.where) ? { ...rows.agent } : null),
        },
        toolkitModules: {
          findFirst: async (opts: any) => (rows.toolkit && matches("toolkit_modules", rows.toolkit, opts?.where) ? { ...rows.toolkit } : null),
        },
        agentSkills: {
          findMany: async (opts: any) => affected("agent_skills", rows.agentSkills ?? [], opts?.where),
          findFirst: async (opts: any) => affected("agent_skills", rows.agentSkills ?? [], opts?.where)[0] ?? null,
        },
        skills: {
          findMany: async (opts: any) => affected("skills", rows.skills ?? [], opts?.where),
          findFirst: async (opts: any) => affected("skills", rows.skills ?? [], opts?.where)[0] ?? null,
        },
      },
    };
  }

  return { state, db, makeTenantDb };
});

vi.mock("../shared/config/database.js", () => ({
  getDb: () => h.state.activeDb ?? h.db,
  dbScopeKey: () => h.state.dbScope,
  // SK-002: mirrors the real ALS binding — ToolExecutor calls
  // runWithDb(agentDb, () => skillsGate.getResolvedToolsForAgent(id)) so the
  // gate reads the tenant handle, and the scope key follows it.
  runWithDb: async (db: any, fn: () => any) => {
    const prevDb = h.state.activeDb;
    const prevScope = h.state.dbScope;
    h.state.activeDb = db;
    h.state.dbScope = db?.__scope ?? prevScope;
    try {
      return await fn();
    } finally {
      h.state.activeDb = prevDb;
      h.state.dbScope = prevScope;
    }
  },
}));

vi.mock("../tools/tools-gate.js", () => ({
  toolsGate: {
    has: (id: string) => {
      if (h.state.registryThrowFor.includes(id)) throw new Error("registry offline");
      return !h.state.registryHidden.includes(id);
    },
  },
  // SK-008: service imports the shared constant statically; mock carries it.
  UNIVERSAL_TOOL_IDS: [
    "open_memory",
    "discard_memory_from_context",
    "remember",
    "lock_in",
    "lock_out",
    "open_detail",
    "load_skill",
    "create_artifact",
  ],
}));

import { skillService } from "./skill-service.js";
import { runWithDb } from "../shared/config/database.js";
import { createSkillSchema, updateSkillSchema } from "./skill-validators.js";

const UNIVERSALS = [
  "open_memory",
  "discard_memory_from_context",
  "remember",
  "lock_in",
  "lock_out",
  "open_detail",
  "load_skill",
  "create_artifact",
];

function row(overrides: Row = {}): Row {
  const now = new Date();
  return {
    id: "skill_seed",
    name: "Seed",
    description: "seed skill",
    category: "general",
    icon: "?",
    promptLayer: { systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] },
    workflowPattern: "react",
    requiredTools: [],
    optionalTools: [],
    recommendedModels: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.skills.length = 0;
  h.state.agentSkills.length = 0;
  h.state.agent = null;
  h.state.toolkit = null;
  h.state.insertAgentSkillError = null;
  h.state.agentSkillFindMisses = 0;
  h.state.registryHidden = [];
  h.state.registryThrowFor = [];
  h.state.listCalls.length = 0;
  h.state.skillQueryCount = 0;
  h.state.linkQueryCount = 0;
  h.state.activeDb = null;
  h.state.dbScope = "test-scope";
  skillService.invalidateAgentCaches();
});

describe("create → list → getById roundtrip", () => {
  it("persists every field and reads it back mapped", async () => {
    const created = await skillService.create({
      name: "Debugging",
      description: "Isolate a defect first.",
      category: "cognitive",
      icon: "x",
      promptLayer: { systemPromptAdditions: ["think stepwise"], executionGuidelines: ["bisect"], fewShotExamples: [] },
      requiredToolIds: ["read_file"],
      optionalToolIds: ["execute_bash"],
      recommendedModels: ["fast-model"],
      workflowPattern: "plan_execute",
    });
    expect(created.id.startsWith("skill_")).toBe(true);
    expect(created.category).toBe("cognitive");
    expect(created.requiredToolIds).toEqual(["read_file"]);
    expect(created.optionalToolIds).toEqual(["execute_bash"]);
    expect(created.recommendedModels).toEqual(["fast-model"]);
    expect(created.workflowPattern).toBe("plan_execute");

    const listed = await skillService.list();
    expect(listed.map((s) => s.id)).toEqual([created.id]);

    const fetched = await skillService.getById(created.id);
    expect(fetched).toEqual(created);
    expect(await skillService.getById("skill_missing")).toBeNull();
  });

  it("clamps the list limit and filters by category", async () => {
    await skillService.create({ name: "A", description: "a", category: "cognitive" });
    await skillService.create({ name: "B", description: "b", category: "swarm" });

    const all = await skillService.list({ limit: 999 });
    expect(all).toHaveLength(2);
    expect(h.state.listCalls.at(-1)?.limit).toBe(200);

    await skillService.list({ limit: 0 });
    expect(h.state.listCalls.at(-1)?.limit).toBe(1);

    const cognitive = await skillService.list({ category: "cognitive" });
    expect(cognitive.map((s) => s.name)).toEqual(["A"]);
    expect(await skillService.list({ category: "swarm" })).toHaveLength(1);
    expect(await skillService.list({ category: "planning" })).toHaveLength(0);
  });
});

describe("partial update merge (the omitted-field contract)", () => {
  it("updateSkillSchema injects no defaults for omitted fields", () => {
    const parsed = updateSkillSchema.parse({ name: "renamed" });
    expect(Object.keys(parsed)).toEqual(["name"]);
    expect("category" in parsed).toBe(false);
    expect("icon" in parsed).toBe(false);
    expect("promptLayer" in parsed).toBe(false);
    expect("requiredToolIds" in parsed).toBe(false);
    expect("workflowPattern" in parsed).toBe(false);
  });

  it("createSkillSchema still applies defaults", () => {
    const parsed = createSkillSchema.parse({ name: "n", description: "d" });
    expect(parsed).toMatchObject({
      category: "general",
      icon: "⚡",
      requiredToolIds: [],
      optionalToolIds: [],
      recommendedModels: [],
      workflowPattern: "react",
      promptLayer: { systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] },
    });
  });

  it("name-only update preserves category, tools, promptLayer, and workflowPattern", async () => {
    const created = await skillService.create({
      name: "Original",
      description: "desc",
      category: "cognitive",
      icon: "x",
      promptLayer: { systemPromptAdditions: ["keep me"], executionGuidelines: ["keep too"] },
      requiredToolIds: ["r1"],
      optionalToolIds: ["o1"],
      recommendedModels: ["m1"],
      workflowPattern: "evaluator_optimizer",
    });

    const updated = await skillService.update(created.id, updateSkillSchema.parse({ name: "renamed" }));
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("renamed");
    expect(updated!.category).toBe("cognitive");
    expect(updated!.icon).toBe("x");
    expect(updated!.promptLayer.systemPromptAdditions).toEqual(["keep me"]);
    expect(updated!.promptLayer.executionGuidelines).toEqual(["keep too"]);
    expect(updated!.requiredToolIds).toEqual(["r1"]);
    expect(updated!.optionalToolIds).toEqual(["o1"]);
    expect(updated!.recommendedModels).toEqual(["m1"]);
    expect(updated!.workflowPattern).toBe("evaluator_optimizer");
  });

  it("promptLayer merges per key and explicit arrays replace", async () => {
    const created = await skillService.create({
      name: "Original",
      description: "desc",
      category: "cognitive",
      promptLayer: { systemPromptAdditions: ["keep"], executionGuidelines: ["old"] },
      requiredToolIds: ["r1"],
    });

    const patched = await skillService.update(created.id, {
      promptLayer: { executionGuidelines: ["new"] },
    });
    expect(patched!.promptLayer.systemPromptAdditions).toEqual(["keep"]);
    expect(patched!.promptLayer.executionGuidelines).toEqual(["new"]);

    const cleared = await skillService.update(created.id, { requiredToolIds: [] });
    expect(cleared!.requiredToolIds).toEqual([]);

    const noop = await skillService.update(created.id, { promptLayer: {} });
    expect(noop!.promptLayer.systemPromptAdditions).toEqual(["keep"]);
    expect(noop!.promptLayer.executionGuidelines).toEqual(["new"]);
  });

  it("returns null when the skill does not exist", async () => {
    expect(await skillService.update("skill_missing", { name: "x" })).toBeNull();
  });
});

describe("delete", () => {
  it("reports whether a row existed and removes it", async () => {
    const created = await skillService.create({ name: "Doomed", description: "d" });
    expect(await skillService.delete(created.id)).toBe(true);
    expect(await skillService.getById(created.id)).toBeNull();
    expect(await skillService.delete(created.id)).toBe(false);
  });
});

describe("assignment and cache invalidation", () => {
  it("upserts a link, re-enables it, and invalidates the agent cache", async () => {
    const skill = await skillService.create({ name: "S", description: "d" });
    h.state.agentSkills.push({ agentId: "agent-1", skillId: skill.id, isEnabled: false });

    await skillService.assignSkill("agent-1", skill.id);
    expect(h.state.agentSkills).toHaveLength(1);
    expect(h.state.agentSkills[0].isEnabled).toBe(true);

    expect((await skillService.getAgentSkills("agent-1")).map((s) => s.id)).toEqual([skill.id]);
    expect(h.state.skillQueryCount).toBe(1);
    expect(h.state.linkQueryCount).toBe(1);
    // Cached: no second round of queries.
    await skillService.getAgentSkills("agent-1");
    expect(h.state.skillQueryCount).toBe(1);
    expect(h.state.linkQueryCount).toBe(1);

    expect(await skillService.removeSkill("agent-1", skill.id)).toBe(true);
    expect(await skillService.getAgentSkills("agent-1")).toEqual([]);
    expect(h.state.linkQueryCount).toBe(2);
    expect(await skillService.removeSkill("agent-1", skill.id)).toBe(false);
  });

  it("treats a concurrent 23505 assign as an idempotent re-enable", async () => {
    h.state.agentSkills.push({ agentId: "agent-1", skillId: "skill_s", isEnabled: false });
    h.state.agentSkillFindMisses = 1; // the race: row not visible yet at the pre-check
    h.state.insertAgentSkillError = { code: "23505" };

    await skillService.assignSkill("agent-1", "skill_s");
    expect(h.state.agentSkills).toHaveLength(1);
    expect(h.state.agentSkills[0].isEnabled).toBe(true);
  });

  it("caches the empty skill set instead of re-querying", async () => {
    expect(await skillService.getAgentSkills("agent-bare")).toEqual([]);
    await skillService.getAgentSkills("agent-bare");
    // The link query runs once; the cached result skips the second call.
    expect(h.state.linkQueryCount).toBe(1);
    expect(h.state.skillQueryCount).toBe(0);
  });
});

describe("promptLayer read mapping", () => {
  it("drops malformed few-shot examples instead of casting them through", async () => {
    h.state.skills.push(
      row({
        id: "skill_fs",
        promptLayer: {
          systemPromptAdditions: ["s"],
          executionGuidelines: [],
          fewShotExamples: [
            {
              scenario: "ok",
              thoughtProcess: "think",
              actions: [{ tool: "t", args: { a: 1 } }, { tool: 42, args: {} }, "junk"],
              expectedOutcome: "done",
            },
            { scenario: "missing-thought" },
            "not-an-object",
          ],
        },
      }),
    );

    const skill = await skillService.getById("skill_fs");
    expect(skill!.promptLayer.fewShotExamples).toHaveLength(1);
    const example = skill!.promptLayer.fewShotExamples![0];
    expect(example.scenario).toBe("ok");
    expect(example.actions).toEqual([{ tool: "t", args: { a: 1 } }]);
  });
});

describe("getResolvedToolsForAgent", () => {
  it("unions toolkit grants, skill requirements, and the seven universals", async () => {
    h.state.agent = { id: "agent-1", toolkitModuleId: "tk-1" };
    h.state.toolkit = { id: "tk-1", tools: ["tool_x"] };
    h.state.agentSkills.push({ agentId: "agent-1", skillId: "skill_s", isEnabled: true });
    h.state.skills.push(row({ id: "skill_s", requiredTools: ["req_a"], optionalTools: ["opt_b"] }));

    const resolved = await skillService.getResolvedToolsForAgent("agent-1");
    expect(resolved).toContain("tool_x");
    expect(resolved).toContain("req_a");
    expect(resolved).toContain("opt_b");
    for (const universal of UNIVERSALS) expect(resolved).toContain(universal);
  });

  it("filters universals through the live registry", async () => {
    h.state.agent = { id: "agent-2" };
    h.state.registryHidden = ["open_detail"];

    const resolved = await skillService.getResolvedToolsForAgent("agent-2");
    expect(resolved).not.toContain("open_detail");
    expect(resolved).toContain("load_skill");
    expect(resolved).toContain("open_memory");
  });

  it("fails open per universal when the registry cannot answer", async () => {
    h.state.agent = { id: "agent-3" };
    h.state.registryThrowFor = ["load_skill"];

    const resolved = await skillService.getResolvedToolsForAgent("agent-3");
    expect(resolved).toContain("load_skill");
    for (const universal of UNIVERSALS) expect(resolved).toContain(universal);
  });

  it("still resolves universals when the agent and toolkit are missing", async () => {
    const resolved = await skillService.getResolvedToolsForAgent("agent-ghost");
    for (const universal of UNIVERSALS) expect(resolved).toContain(universal);
  });
});

// ─── Ledger regressions: SK-002 (split-DB authz) / SK-003 (cross-scope cache)
describe("SK-002/SK-003: split-DB resolution and cross-scope invalidation", () => {
  it("SK-002: resolves tools against the bound tenant handle (split-DB fixture)", async () => {
    // The same agentId exists in two tenant DBs with different toolkits. The
    // executor binds the agent row's handle via runWithDb; resolution must
    // follow that handle — never a shared pool — and caches must not bleed.
    const tenantA = h.makeTenantDb("wsA", {
      agent: { id: "agent-1", toolkitModuleId: "tk-A" },
      toolkit: { id: "tk-A", tools: ["tool_a"] },
    });
    const tenantB = h.makeTenantDb("wsB", {
      agent: { id: "agent-1", toolkitModuleId: "tk-B" },
      toolkit: { id: "tk-B", tools: ["tool_b"] },
    });

    const underA = await runWithDb(tenantA, () => skillService.getResolvedToolsForAgent("agent-1"));
    const underB = await runWithDb(tenantB, () => skillService.getResolvedToolsForAgent("agent-1"));

    expect(underA).toContain("tool_a");
    expect(underA).not.toContain("tool_b");
    expect(underB).toContain("tool_b");
    expect(underB).not.toContain("tool_a");
  });

  it("SK-003: a write in scope A invalidates the scope-B reader's cache", async () => {
    h.state.skills.push(row({ id: "skill_a", requiredTools: ["req_a"] }));
    h.state.agentSkills.push({ agentId: "agent-x", skillId: "skill_a", isEnabled: true });

    // Populate both scopes' caches (resolved tools + agent skills).
    h.state.dbScope = "wsA";
    expect(await skillService.getResolvedToolsForAgent("agent-x")).toContain("req_a");
    h.state.dbScope = "wsB";
    expect(await skillService.getResolvedToolsForAgent("agent-x")).not.toContain("req_b");

    // New grant lands; the write (assignSkill) runs in wsA only.
    h.state.skills.push(row({ id: "skill_b", requiredTools: ["req_b"] }));
    h.state.dbScope = "wsA";
    await skillService.assignSkill("agent-x", "skill_b");

    // The wsB reader must see the fresh grant, not its cached entry.
    h.state.dbScope = "wsB";
    expect(await skillService.getResolvedToolsForAgent("agent-x")).toContain("req_b");
    expect((await skillService.getAgentSkills("agent-x")).map((s) => s.id).sort()).toEqual(["skill_a", "skill_b"]);
  });
});
