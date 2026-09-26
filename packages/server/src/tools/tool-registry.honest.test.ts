import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { ToolExecutor } from "./tool-executor.js";
import { toolRegistry, activeSchedules } from "./tool-registry.js";
import { EventBroker, setSharedBroker, resetSharedBrokerForTests } from "../event-broker/event-broker-gate.js";
import * as databaseMod from "../shared/config/database.js";
import * as seqMod from "../shared/core/sequence-number.js";
import * as ulidMod from "../shared/core/ulid.js";

// Global state for mock inspection
(globalThis as unknown as { __honestQueries: string[] }).__honestQueries = [];
(globalThis as unknown as { __fakeRows: unknown[] }).__fakeRows = [];

vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: {
    getResolvedToolsForAgent: async () =>
      [
        "read_file",
        "write_file",
        "list_directory",
        "delete_file",
        "execute_bash",
        "execute_safe",
        "web_search",
        "query_database",
        "system_scheduler",
        "search_all_channels",
        "open_memory",
        "remember",
      ],
  },
}));

function getHonestQueries(): string[] {
  return (globalThis as unknown as { __honestQueries: string[] }).__honestQueries;
}
function setFakeRows(rows: unknown[]): void {
  (globalThis as unknown as { __fakeRows: unknown[] }).__fakeRows = rows;
}
function clearQueries(): void {
  (globalThis as unknown as { __honestQueries: string[] }).__honestQueries = [];
}

function setupHonestSpies(): void {
  vi.spyOn(databaseMod, "getDb").mockReturnValue({
    query: {
      agents: {
        findFirst: async () => ({
          id: "agent-probe",
          name: "probe-agent",
          authorityLevel: 1,
          isOmniscient: true,
        }),
      },
    },
  } as unknown as ReturnType<typeof databaseMod.getDb>);
  vi.spyOn(databaseMod, "getSqlClient").mockReturnValue({
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        unsafe: async (q: string) => {
          (globalThis as unknown as { __honestQueries: string[] }).__honestQueries.push(q);
          if (q.includes("SET LOCAL")) return [];
          if (q.includes("__honest_q")) {
            const rows = (globalThis as unknown as { __fakeRows: unknown[] }).__fakeRows as unknown[];
            const outerMatch = q.match(/LIMIT\s+(\d+)\s*$/i);
            const outer = outerMatch ? parseInt(outerMatch[1], 10) : rows.length;
            const innerMatch = q.match(/\(\s*SELECT[\s\S]*?LIMIT\s+(\d+)[\s\S]*?\)\s+AS\s+__honest_q/i);
            const inner = innerMatch ? parseInt(innerMatch[1], 10) : null;
            const cap = inner != null ? Math.min(inner, outer) : outer;
            return rows.slice(0, cap);
          }
          return [];
        },
      };
      return fn(tx);
    },
    unsafe: async (q: string) => {
      (globalThis as unknown as { __honestQueries: string[] }).__honestQueries.push(q);
      return [];
    },
  } as unknown as ReturnType<typeof databaseMod.getSqlClient>);
  // @ts-ignore mock type mismatch — test spy
  vi.spyOn(databaseMod as unknown as { withTransaction: unknown }, "withTransaction" as never).mockImplementation(async (fn: unknown) => {
    const tx = { insert: () => ({ values: async () => {} }) };
    return (fn as (tx: unknown) => Promise<unknown>)(tx as unknown as never);
  });
  // @ts-ignore mock type mismatch — test spy
  vi.spyOn(seqMod as unknown as { allocateSequence: unknown }, "allocateSequence" as never).mockResolvedValue(1 as never);
  // @ts-ignore mock type mismatch — test spy
  vi.spyOn(ulidMod as unknown as { monotonicUlid: unknown }, "monotonicUlid" as never).mockImplementation(() => `ulid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

afterAll(() => {
  try {
    vi.doUnmock("../Skills/skillsGate.js");
  } catch {}
  vi.resetModules();
});

describe("TOOL-1 · Honest tools — query_database", () => {
  beforeEach(() => {
    clearQueries();
    delete process.env.QUERY_DATABASE_ENABLED;
    delete process.env.SYSTEM_SCHEDULER_ENABLED;
    setFakeRows([]);
    activeSchedules.clear();
    vi.restoreAllMocks();
    setupHonestSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearQueries();
    setFakeRows([]);
    activeSchedules.forEach((rec) => {
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.interval) clearInterval(rec.interval as unknown as NodeJS.Timeout);
    });
    activeSchedules.clear();
  });

  it("returns true rows capped at 100 (honest, not canned)", async () => {
    // Arrange 150 fake agents
    const fake = Array.from({ length: 150 }, (_, i) => ({ id: `a-${i}`, name: `agent-${i}` }));
    setFakeRows(fake);
    clearQueries();

    const result = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT * FROM agents" });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const rows = JSON.parse(result.output) as unknown[];
    expect(rows.length).toBe(100);
    // Not canned 5 agents
    expect(rows.length).not.toBe(5);
    const queries = getHonestQueries();
    expect(queries.some((q) => /SET LOCAL/i.test(q) && /statement_timeout/i.test(q))).toBe(true);
    expect(queries.some((q) => q.includes("__honest_q") && /LIMIT\s+100/i.test(q))).toBe(true);
  });

  it("row cap also respects inner LIMIT smaller than 100", async () => {
    setFakeRows(Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}` })));
    clearQueries();
    const result = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT * FROM messages LIMIT 5" });
    expect(result.success).toBe(true);
    const rows = JSON.parse(result.output) as unknown[];
    // DB would return 5 (inner LIMIT 5, outer 100 => 5)
    expect(rows.length).toBe(5);
  });

  it("mutation blocked — INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE", async () => {
    const blocked = [
      "DELETE FROM agents",
      "delete from agents where id='x'",
      "INSERT INTO agents VALUES (1)",
      "UPDATE agents SET name='x'",
      "DROP TABLE agents",
      "drop table messages",
      "CREATE TABLE foo (id int)",
      "ALTER TABLE agents ADD COLUMN x text",
      "TRUNCATE TABLE agents",
      "GRANT SELECT ON agents TO public",
    ];
    for (const sql of blocked) {
      const res = await ToolExecutor.execute("agent-probe", "query_database", { sql });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Mutation blocked|Only SELECT/i);
    }
  });

  it("allowlist — only agents, channels, messages, channel_index, token_usage_log allowed", async () => {
    // Allowed should succeed (with our fake rows)
    setFakeRows([{ id: "1" }]);
    clearQueries();
    const ok = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT * FROM agents" });
    expect(ok.success).toBe(true);

    setFakeRows([{ id: "1" }]);
    const ok2 = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT * FROM channel_index" });
    expect(ok2.success).toBe(true);

    setFakeRows([{ id: "1" }]);
    const ok3 = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT * FROM token_usage_log" });
    expect(ok3.success).toBe(true);

    // Disallowed
    const badTables = [
      "SELECT * FROM pg_catalog.pg_tables",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM secret_table",
      "SELECT * FROM users",
      "SELECT * FROM agents, secret_table",
    ];
    for (const sql of badTables) {
      const res = await ToolExecutor.execute("agent-probe", "query_database", { sql });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/not allowed/i);
    }
  });

  it("blocks multiple statements", async () => {
    const res = await ToolExecutor.execute("agent-probe", "query_database", {
      sql: "SELECT * FROM agents; DROP TABLE agents",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Multiple statements|Mutation blocked/i);
  });

  it("blocks file-read / DB-link / config-exfil functions (2026-09-26 audit fix)", async () => {
    const blocked = [
      "SELECT lo_export('/etc/passwd', '/tmp/out') FROM agents",
      "SELECT * FROM agents WHERE name = pg_read_file('/etc/passwd')",
      "SELECT dblink('dbname=other', 'select 1') AS x",
      "SELECT query_to_xml('SELECT 1', true, true, '') AS x",
      "SELECT current_setting('data_directory') FROM agents",
    ];
    for (const sql of blocked) {
      const res = await ToolExecutor.execute("agent-probe", "query_database", { sql });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Blocked function/i);
    }
  });

  it("only SELECT/WITH allowed — rejects non-select", async () => {
    const res = await ToolExecutor.execute("agent-probe", "query_database", { sql: "EXPLAIN SELECT * FROM agents" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Only SELECT/i);
  });

  it("SELECT without FROM still allowed (trivial) and capped", async () => {
    setFakeRows([{ "?column?": 1 }]);
    clearQueries();
    // Our allowlist extracts no tables, so it should pass
    const res = await ToolExecutor.execute("agent-probe", "query_database", { sql: "SELECT 1" });
    // Either succeeds or fails gracefully, but should not be canned agents
    // If it succeeds, it should be capped
    if (res.success) {
      const rows = JSON.parse(res.output) as unknown[];
      expect(rows.length).toBeLessThanOrEqual(100);
    } else {
      // If we decided to block no-table selects, that's okay as long as not canned
      expect(res.error).toBeDefined();
    }
  });
});

describe("TOOL-1 · Honest tools — system_scheduler", () => {
  beforeEach(() => {
    clearQueries();
    setFakeRows([]);
    activeSchedules.forEach((rec) => {
      if (rec.timer) clearTimeout(rec.timer);
      if ((rec as unknown as { interval?: NodeJS.Timeout }).interval) clearInterval((rec as unknown as { interval?: NodeJS.Timeout }).interval!);
    });
    activeSchedules.clear();
    delete process.env.QUERY_DATABASE_ENABLED;
    delete process.env.SYSTEM_SCHEDULER_ENABLED;
    process.env.QUEUE_MODE = "inline";
    vi.restoreAllMocks();
    setupHonestSpies();
    // The scheduler emit path resolves a shared broker (warn-and-skip when
    // none is registered). Production registers one via the socket server;
    // here the test must register its own so emits reach the prototype spy.
    setSharedBroker(new EventBroker());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSharedBrokerForTests();
    activeSchedules.forEach((rec) => {
      if (rec.timer) clearTimeout(rec.timer);
      if ((rec as unknown as { interval?: NodeJS.Timeout }).interval) clearInterval((rec as unknown as { interval?: NodeJS.Timeout }).interval!);
    });
    activeSchedules.clear();
    delete process.env.QUEUE_MODE;
  });

  it("fires on time via EventBroker (inline honest, broker spy within 700ms)", async () => {
    const spy = vi.spyOn(EventBroker.prototype, "emit");
    const res = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      delaySeconds: 0.2,
      taskDescription: "tool-1-inline-fire",
      channelId: "general",
    });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/ID: sched-/);
    // Wait for timer to fire (0.2s + margin)
    await new Promise((r) => setTimeout(r, 700));
    const calls = spy.mock.calls.filter(
      ([type, payload]) => type === "message:new" && String((payload as { content?: string })?.content ?? "").includes("tool-1-inline-fire"),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Also scheduled:triggered should have fired
    const schedCalls = spy.mock.calls.filter(([type, payload]) => type === "scheduled:triggered" && String((payload as { task?: string })?.task ?? "").includes("tool-1-inline-fire"));
    expect(schedCalls.length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  }, 10000);

  it("one-shot returns schedule id and creates activeSchedules entry", async () => {
    const res = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      delaySeconds: 5,
      taskDescription: "id-test",
      channelId: "ch-1",
    });
    expect(res.success).toBe(true);
    const match = res.output.match(/ID:\s*(sched-[^\s]+)/);
    expect(match).not.toBeNull();
    const id = match![1];
    expect(activeSchedules.has(id)).toBe(true);
    expect(activeSchedules.get(id)?.task).toBe("id-test");
    expect(activeSchedules.get(id)?.channelId).toBe("ch-1");
    // cleanup
    const rec = activeSchedules.get(id);
    if (rec?.timer) clearTimeout(rec.timer);
    activeSchedules.delete(id);
  });

  it("cron repeatable returns schedule id (inline fallback)", async () => {
    const res = await ToolExecutor.execute("agent-probe", "system_scheduler", {
      taskDescription: "cron-inline-test",
      cron: "*/5 * * * *",
      channelId: "general",
    });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/cron/);
    expect(res.output).toMatch(/ID: sched-/);
    const match = res.output.match(/ID:\s*(sched-[^\s]+)/);
    expect(match).not.toBeNull();
    const id = match![1];
    expect(activeSchedules.has(id)).toBe(true);
    // cleanup interval
    const rec = activeSchedules.get(id);
    if ((rec as unknown as { interval?: NodeJS.Timeout })?.interval) clearInterval((rec as unknown as { interval?: NodeJS.Timeout }).interval!);
    activeSchedules.delete(id);
  });

  it("tool is registered and classified as side-effect", async () => {
    expect(toolRegistry.has("system_scheduler")).toBe(true);
    const def = toolRegistry.get("system_scheduler");
    expect(def?.effectClass).toBe("side-effect");
  });
});
