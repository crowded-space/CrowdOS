import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

describe("TOOL-1 · flags — rollback unregister", () => {
  const originalEnv: Record<string, string | undefined> = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // restore env
    for (const k of Object.keys(process.env)) delete (process.env as unknown as Record<string, string | undefined>)[k];
    for (const [k, v] of Object.entries(originalEnv)) if (v !== undefined) (process.env as unknown as Record<string, string | undefined>)[k] = v;
    vi.resetModules();
  });

  it("QUERY_DATABASE_ENABLED=false unregisters query_database", async () => {
    process.env.QUERY_DATABASE_ENABLED = "false";
    process.env.SYSTEM_SCHEDULER_ENABLED = "true";
    const mod = await import("./toolRegistry.js");
    expect(mod.toolRegistry.has("query_database")).toBe(false);
    expect(mod.toolRegistry.has("system_scheduler")).toBe(true);
  });

  it("SYSTEM_SCHEDULER_ENABLED=false unregisters system_scheduler", async () => {
    process.env.QUERY_DATABASE_ENABLED = "true";
    process.env.SYSTEM_SCHEDULER_ENABLED = "false";
    const mod = await import("./toolRegistry.js");
    expect(mod.toolRegistry.has("query_database")).toBe(true);
    expect(mod.toolRegistry.has("system_scheduler")).toBe(false);
  });

  it("both false unregisters both", async () => {
    process.env.QUERY_DATABASE_ENABLED = "false";
    process.env.SYSTEM_SCHEDULER_ENABLED = "false";
    const mod = await import("./toolRegistry.js");
    expect(mod.toolRegistry.has("query_database")).toBe(false);
    expect(mod.toolRegistry.has("system_scheduler")).toBe(false);
  });
});
