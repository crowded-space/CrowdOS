import { randomUUID } from "node:crypto";
import { afterEach, vi } from "vitest";

/**
 * Global vitest setup: provides an opt-in in-memory database/channelGate fake
 * for tests that must run hermetically (socket integration, runtime harnesses).
 *
 * Mechanics: a test file sets `process.env.__SOCKET_FAKE_DB__ = "1"` via
 * vi.hoisted BEFORE its static imports; the mocked factories below then serve
 * the fake instead of the real module. Files without the flag get the REAL
 * database module (real-DB integration tests are the default). The flag is
 * cleared after every test file so it cannot leak across workers.
 *
 * Rationale: vitest v4 does not propagate vi.mock registered inside a test
 * file to transitive importers in other directories; registering from a
 * setupFile reaches them. Factories must be synchronous when serving fakes and
 * must NOT load the actual module in that case (that repopulates the real
 * module cache and other importers silently fall through to it).
 *
 * Exports __socketTestDb / __socketTestChannelGate so tests can reset state
 * between scenarios and wire per-test lookup behavior.
 */

type Row = Record<string, unknown>;

const store = {
  apiKeys: [] as Row[],
  messages: [] as Row[],
  channels: [] as Row[],
  workspaces: [] as Row[],
  agents: [] as Row[],
};

// DB-2: monotonic fake sequence source backing allocateSequence's
// INSERT ... RETURNING shape under the in-memory fake.
let fakeSequence = 0;

let channelOverride: ((id: string) => Promise<unknown>) | null = null;

function drizzleTableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

function rowsFor(table: unknown): Row[] | null {
  switch (drizzleTableName(table)) {
    case "api_keys": return store.apiKeys;
    case "messages": return store.messages;
    case "channels": return store.channels;
    case "workspaces": return store.workspaces;
    case "agents": return store.agents;
    default: return null;
  }
}

function buildFakeDb() {
  function insert(table: unknown) {
    return {
      values(values: Row) {
        const rec: Row = { ...values };
        if (drizzleTableName(table) === "api_keys" && typeof rec.id !== "string") rec.id = randomUUID();
        const done = async () => {
          rowsFor(table)?.push(rec);
          return rec;
        };
        const promise = done() as Promise<Row> & { returning: () => Promise<Row[]> };
        promise.returning = async () => [rec];
        return promise;
      },
    };
  }

  function update(_table: unknown) {
    return {
      set(_patch: Row) {
        return {
          where: async () => [] as Row[],
          returning: async () => [] as Row[],
        };
      },
    };
  }

  function _delete(_table: unknown) {
    return { where: async () => [] as Row[] };
  }

  function selectResult(table: unknown): Promise<Row[]> & { limit: () => Promise<Row[]> } {
    const rows =
      drizzleTableName(table) === "api_keys"
        ? store.apiKeys.filter((r) => !r.revokedAt).map((r) => ({ ...r }))
        : [];
    const promise = Promise.resolve(rows.map((r) => ({ ...r }))) as Promise<Row[]> & {
      limit: () => Promise<Row[]>;
    };
    promise.limit = async () => rows.map((r) => ({ ...r }));
    return promise;
  }

  function select() {
    return {
      from(table: unknown) {
        return {
          where: () => selectResult(table),
          limit: () => selectResult(table),
        };
      },
    };
  }

  function execute() {
    return Promise.resolve([{ last_seq: ++fakeSequence }]);
  }

  // DB-2: allocator/tx support. execute() answers the channel_sequences upsert
  // shape; transaction() reuses the same instance (store arrays are shared).
  const knownQueryTables: Record<string, unknown> = {
    messages: {
      findFirst: async () =>
        store.messages.length > 0 ? { ...store.messages[store.messages.length - 1] } : null,
      // Fidelity: the real query orders newest-first (timestamp desc,
      // sequenceNumber desc) and the merge pairs chronologically after
      // reversing — insertion order here would invert the pairing.
      findMany: async () =>
        store.messages
          .map((r) => ({ ...r }))
          .sort((a, b) => {
            const tb = new Date(b.timestamp as string | Date).getTime();
            const ta = new Date(a.timestamp as string | Date).getTime();
            if (tb !== ta) return tb - ta;
            return Number(b.sequenceNumber ?? 0) - Number(a.sequenceNumber ?? 0);
          }),
    },
    channels: {
      findFirst: async () => (store.channels.length > 0 ? { ...store.channels[0] } : null),
      findMany: async () => store.channels.map((r) => ({ ...r })),
    },
    categories: { findFirst: async () => null, findMany: async () => [] },
    agents: {
      findFirst: async () => (store.agents.length > 0 ? { ...store.agents[0] } : null),
      // Where-clause filters are opaque to this fake; socket tests only ever
      // list non-template agents, so rows are stored pre-filtered.
      findMany: async () => store.agents.map((r) => ({ ...r })),
    },
    workspaces: {
      findFirst: async () => (store.workspaces.length > 0 ? { ...store.workspaces[0] } : null),
      findMany: async () => store.workspaces.map((r) => ({ ...r })),
    },
  };

  const query: Record<string, unknown> = new Proxy(knownQueryTables, {
    get(target, prop) {
      if (typeof prop === "string" && prop in target) return target[prop];
      return {
        findFirst: async () => null,
        findMany: async () => [],
      };
    },
  });

  const db: {
    insert: typeof insert;
    update: typeof update;
    delete: typeof _delete;
    select: typeof select;
    query: typeof query;
    execute: typeof execute;
    transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
  } = {
    insert,
    update,
    delete: _delete,
    select,
    query,
    execute,
    transaction: (fn) => fn(db as never),
  };

  return db;
}

vi.mock("./shared/config/database.js", async (importOriginal) => {
  if (process.env.__SOCKET_FAKE_DB__ !== "1") {
    return await importOriginal<Record<string, unknown>>();
  }
  return {
  getDb: () => buildFakeDb(),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the socket test fake");
  },
  ensurePgVectorExtension: async () => {},
  closeDatabaseConnection: async () => {},
  withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(buildFakeDb()),
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
  __socketTestDb: {
    store,
    reset() {
      store.apiKeys.length = 0;
      store.messages.length = 0;
      store.channels.length = 0;
      store.workspaces.length = 0;
      store.agents.length = 0;
    },
  },
  };
});

vi.mock("./channels/channel-gate.js", async (importOriginal) => {
  if (process.env.__SOCKET_FAKE_DB__ !== "1") {
    return await importOriginal<Record<string, unknown>>();
  }
  return {
  channelGate: {
    get: async (id: string) => (channelOverride ? channelOverride(id) : null),
    categoryExists: async () => false,
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => ({}),
  },
  __socketTestChannelGate: {
    setOverride(fn: ((id: string) => Promise<unknown>) | null) {
      channelOverride = fn;
    },
  },
  };
});

afterEach(() => {
  delete process.env.__SOCKET_FAKE_DB__;
});
