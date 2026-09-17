import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/database.js", async () => {
  const rows = (await import("./model-routing.test-fixtures.js")).routingModuleRows;
  return {
    getDb: () => ({
      select(fields: Record<string, unknown>) {
        void fields;
        return {
          from() {
            return Promise.resolve(rows());
          },
        };
      },
    }),
    dbScopeKey: () => "global",
  };
});

import {
  loadRoutingModules,
  resetRoutingCacheForTests,
  resolveModelModule,
  routingEnabled,
  taskClassForRuntime,
  tierOf,
  type RoutableModelModule,
} from "./model-routing.js";

function mod(
  id: string,
  modelName: string,
  costPer1k: number | null = null,
  hasApiKey = true
): RoutableModelModule {
  return { id, provider: "google", modelName, costPer1k, hasApiKey };
}

const POOL: RoutableModelModule[] = [
  mod("mod-flash-cheap", "gemini-2.0-flash", 0.1),
  mod("mod-flash-pricey", "gemma-4-27b", 0.4),
  mod("mod-frontier", "gemini-2.5-pro", 2.5),
];

describe("MODEL-1 · tier inference", () => {
  it("classifies flash-tier and frontier-tier model names", () => {
    expect(tierOf("gemini-2.0-flash")).toBe("flash");
    expect(tierOf("gemma-4-27b")).toBe("flash");
    expect(tierOf("gpt-4o-mini")).toBe("flash");
    expect(tierOf("gemini-2.5-pro")).toBe("frontier");
    expect(tierOf("claude-opus-4")).toBe("frontier");
    expect(tierOf("mystery-model")).toBeNull();
  });
});

describe("MODEL-1 · task-class mapping", () => {
  it("maps runtime types onto task classes", () => {
    expect(taskClassForRuntime("conversational")).toBe("chat");
    expect(taskClassForRuntime("agentic")).toBe("planning");
    expect(taskClassForRuntime("coding")).toBe("coding");
    expect(taskClassForRuntime("swarm")).toBe("chat");
  });
});

describe("MODEL-1 · resolveModelModule", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.MODEL_ROUTE;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.MODEL_ROUTE;
    logSpy.mockRestore();
  });

  function routedDecisions(): Array<Record<string, any>> {
    return logSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((line: unknown): line is string => typeof line === "string" && line.startsWith("{"))
      .map((line: string) => JSON.parse(line) as Record<string, any>)
      .filter((m: Record<string, any>) => m.stage === "model.route");
  }

  it("pins librarian to the cheapest capable flash module", () => {
    const decision = resolveModelModule({
      runtimeType: "librarian",
      taskClass: "librarian",
      availableModules: POOL,
      staticModuleId: "mod-frontier",
    });

    expect(decision).toEqual({ moduleId: "mod-flash-cheap", tier: "flash", overridden: true });
    const logged = routedDecisions().at(-1);
    expect(logged).toMatchObject({
      stage: "model.route",
      runtimeType: "librarian",
      taskClass: "librarian",
      chosenModuleId: "mod-flash-cheap",
      tier: "flash",
      overridden: true,
    });
  });

  it("prefers frontier for planning and falls back down the chain", () => {
    const decision = resolveModelModule({
      runtimeType: "agentic",
      taskClass: "planning",
      availableModules: POOL,
      staticModuleId: "mod-flash-cheap",
    });
    expect(decision.moduleId).toBe("mod-frontier");

    const noFrontier = resolveModelModule({
      runtimeType: "agentic",
      taskClass: "planning",
      availableModules: POOL.filter((m) => m.id !== "mod-frontier"),
      staticModuleId: "mod-static",
    });
    expect(noFrontier.moduleId).toBe("mod-flash-cheap");
  });

  it("keeps reflection strictly on cheap tier, falling back to static when absent", () => {
    const fallback = resolveModelModule({
      runtimeType: "reflection",
      taskClass: "reflection",
      availableModules: [mod("mod-frontier", "gemini-2.5-pro", 2.5)],
      staticModuleId: "mod-static",
    });
    expect(fallback).toEqual({ moduleId: "mod-static", tier: "static", overridden: false });
  });

  it("never routes onto credential-less modules when credentials are required", () => {
    const decision = resolveModelModule({
      runtimeType: "librarian",
      taskClass: "librarian",
      availableModules: [mod("mod-flash-nokey", "gemini-2.0-flash", 0.05, false)],
      staticModuleId: "mod-static",
      requireCredential: true,
    });
    expect(decision.moduleId).toBe("mod-static");
  });

  it("logs but does not swap in logOnly mode (chat behavior unchanged)", () => {
    const decision = resolveModelModule({
      runtimeType: "conversational",
      taskClass: "chat",
      availableModules: POOL,
      staticModuleId: "mod-agent-pinned",
      logOnly: true,
    });

    expect(decision).toEqual({ moduleId: "mod-agent-pinned", tier: "static", overridden: false });
    const logged = routedDecisions().at(-1);
    expect(logged).toMatchObject({
      stage: "model.route",
      runtimeType: "conversational",
      taskClass: "chat",
      chosenModuleId: "mod-agent-pinned",
      tier: "static",
      candidateModuleId: "mod-flash-cheap",
      candidateTier: "flash",
    });
  });

  it("bypasses entirely under MODEL_ROUTE=static", () => {
    process.env.MODEL_ROUTE = "static";

    const decision = resolveModelModule({
      runtimeType: "librarian",
      taskClass: "librarian",
      availableModules: POOL,
      staticModuleId: "mod-pinned",
    });

    expect(decision).toEqual({ moduleId: "mod-pinned", tier: "static", overridden: false });
    expect(routingEnabled()).toBe(false);
    const logged = routedDecisions().at(-1);
    expect(logged).toMatchObject({ stage: "model.route", tier: "static", bypass: true });
  });
});

describe("MODEL-1 · loadRoutingModules", () => {
  afterEach(() => {
    resetRoutingCacheForTests();
  });

  it("maps DB rows into routable modules with credential flags and caching", async () => {
    resetRoutingCacheForTests();
    const first = await loadRoutingModules();
    const second = await loadRoutingModules();

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    for (const entry of first) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("costPer1k");
      expect(typeof entry.hasApiKey).toBe("boolean");
    }
  });
});
