// TOLS-05 regression: MCP server configs must survive a process restart.
//
// The manager used to keep sessions memory-only, so every registered server
// vanished on restart (and the mcp_servers table rotted). This suite simulates
// a restart hermetically: register against an injected fake handle, then
// construct a FRESH manager over the SAME handle and assert the configs come
// back; unregister must delete the row so the next boot restores nothing.
//
// Hermetic: the database module is mocked (getDb throws, isDatabaseConfigured
// false) so only the explicit dbOverride path can pass — a regression back to
// ambient getDb() fails loudly instead of hitting a live DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/config/database.js")>();
  return {
    ...actual,
    getDb: () => {
      throw new Error("hermetic test: getDb() must not be called; thread an explicit handle");
    },
    isDatabaseConfigured: () => false,
  };
});

import { McpClientManager } from "./mcp-client-manager.js";
import type { McpServerConfig } from "./mcp-types.js";

const dialect = new PgDialect();

/** Extract the bound id from a drizzle `eq(table.id, value)` where-clause. */
function deleteWhereId(expr: unknown): string | null {
  try {
    const q = dialect.sqlToQuery(expr as never);
    const params = (q.params ?? []) as unknown[];
    return params.length > 0 ? String(params[0]) : null;
  } catch {
    return null;
  }
}

/** Minimal drizzle-shaped in-memory mcp_servers store. */
function makeFakeHandle() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    insert(_table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          const apply = (set?: Record<string, unknown>) => {
            rows.set(String(row.id), { ...row, ...(set ?? {}) });
            return Promise.resolve();
          };
          return {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => apply().then(res, rej),
            onConflictDoUpdate: ({ set }: { set?: Record<string, unknown> }) => apply(set),
          };
        },
      };
    },
    select() {
      return {
        from: async (_table: unknown) => Array.from(rows.values()).map((r) => ({ ...r })),
      };
    },
    delete(_table: unknown) {
      return {
        where: async (expr: unknown) => {
          const id = deleteWhereId(expr);
          if (id !== null) rows.delete(id);
        },
      };
    },
  };
}

let seq = 0;
function makeConfig(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  seq += 1;
  return {
    id: `persist-${seq}`,
    name: `Persisted ${seq}`,
    transport: "stdio",
    command: "node",
    args: ["--version"],
    autoStart: false, // no child processes: the fake handle never spawns
    ...extra,
  };
}

describe("TOLS-05 MCP config persistence", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("register persists the row; a fresh manager restores the configs (restart sim)", async () => {
    const handle = makeFakeHandle();
    const first = new McpClientManager();

    const alpha = makeConfig({ envVars: { API_TOKEN: "tok-123" } });
    const beta = makeConfig({ name: "Beta", args: [] });
    await first.registerServer(alpha, handle);
    await first.registerServer(beta, handle);

    expect(handle.rows.size).toBe(2);
    const rowAlpha = handle.rows.get(alpha.id)!;
    expect(rowAlpha.name).toBe(alpha.name);
    expect(rowAlpha.transport).toBe("stdio");
    expect(rowAlpha.command).toBe("node");
    expect(rowAlpha.args).toEqual(["--version"]);
    expect(rowAlpha.envVars).toEqual({ API_TOKEN: "tok-123" });
    expect(rowAlpha.autoStart).toBe(false);

    // Re-register = update, not duplicate (UPSERT path).
    await first.registerServer({ ...alpha, name: "Alpha renamed" }, handle);
    expect(handle.rows.size).toBe(2);
    expect(handle.rows.get(alpha.id)!.name).toBe("Alpha renamed");

    // "Restart": fresh manager, same persisted store.
    const second = new McpClientManager();
    expect(second.listStatuses()).toEqual([]);
    const restored = await second.restoreServersFromDb(handle);
    expect(restored).toBe(2);

    const ids = second.listStatuses().map((s) => s.id).sort();
    expect(ids).toEqual([alpha.id, beta.id].sort());
    const alphaStatus = second.getStatus(alpha.id)!;
    expect(alphaStatus.name).toBe("Alpha renamed");
    expect(alphaStatus.status).toBe("disconnected");
    expect(alphaStatus.toolCount).toBe(0);
  });

  it("unregister deletes the persisted row; the next boot restores nothing for it", async () => {
    const handle = makeFakeHandle();
    const first = new McpClientManager();
    const keep = makeConfig();
    const drop = makeConfig();
    await first.registerServer(keep, handle);
    await first.registerServer(drop, handle);

    const second = new McpClientManager();
    await second.restoreServersFromDb(handle);
    await second.unregisterServer(drop.id, handle);

    expect(second.getStatus(drop.id)).toBeNull();
    expect(handle.rows.has(drop.id)).toBe(false);
    expect(handle.rows.has(keep.id)).toBe(true);

    const third = new McpClientManager();
    const restored = await third.restoreServersFromDb(handle);
    expect(restored).toBe(1);
    expect(third.getStatus(keep.id)).not.toBeNull();
    expect(third.getStatus(drop.id)).toBeNull();
  });

  it("registration without a configured database stays in-memory and never throws", async () => {
    // No dbOverride + isDatabaseConfigured() false -> persist is a no-op;
    // the mocked getDb() would throw if the manager fell back to it.
    const manager = new McpClientManager();
    const config = makeConfig();
    await manager.registerServer(config);
    expect(manager.getStatus(config.id)!.status).toBe("disconnected");
    await manager.unregisterServer(config.id);
    expect(manager.getStatus(config.id)).toBeNull();
  });
});
