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

// TG-1/TG-4 seams: per-workspace marker handles, a recording runWithDb, and an
// opt-in fake ALS. Default runWithDb stays passthrough (fn() only); fake ALS is
// enabled only by tests that assert a bare getDb() inside the bound scope.
let fakeAlsEnabled = false;
let currentBoundDb: unknown = null;
let lastBoundDb: unknown = null;
const boundCalls: unknown[] = [];
let workspaceDbResolver: ((workspaceId: string) => Promise<unknown> | unknown) | null = null;
const workspaceDbHandles = new Map<string, unknown>();

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

function buildFakeDb(marker?: string) {
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
        // THR-025 regression: createThread's sequence bootstrap chains
        // .onConflictDoNothing() on the insert builder — mirror drizzle's
        // chainable shape (awaiting the promise already performs the insert).
        (promise as unknown as { onConflictDoNothing: () => Promise<unknown> }).onConflictDoNothing = async () => promise;
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

  if (marker) (db as unknown as Record<string, unknown>).__workspaceMarker = marker;
  return db;
}

function workspaceFakeDb(workspaceId: string): unknown {
  let handle = workspaceDbHandles.get(workspaceId);
  if (!handle) {
    handle = buildFakeDb(workspaceId);
    workspaceDbHandles.set(workspaceId, handle);
  }
  return handle;
}

vi.mock("./shared/config/database.js", async (importOriginal) => {
  if (process.env.__SOCKET_FAKE_DB__ !== "1") {
    return await importOriginal<Record<string, unknown>>();
  }
  return {
  getDb: () => (fakeAlsEnabled && currentBoundDb ? currentBoundDb : buildFakeDb()),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the socket test fake");
  },
  ensurePgVectorExtension: async () => {},
  closeDatabaseConnection: async () => {},
  withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(buildFakeDb()),
  runWithDb: <T>(db: unknown, fn: () => T): T => {
    lastBoundDb = db;
    boundCalls.push(db);
    if (!fakeAlsEnabled) return fn();
    const previous = currentBoundDb;
    currentBoundDb = db;
    try {
      const out = fn();
      if (out && typeof (out as { then?: unknown }).then === "function") {
        return (out as unknown as Promise<unknown>).finally(() => {
          currentBoundDb = previous;
        }) as T;
      }
      currentBoundDb = previous;
      return out;
    } catch (err) {
      currentBoundDb = previous;
      throw err;
    }
  },
  dbForWorkspace: async (workspaceId: string | null | undefined): Promise<unknown> => {
    if (workspaceDbResolver) return workspaceDbResolver(workspaceId as string);
    if (!workspaceId) {
      throw Object.assign(new Error("NO_DATABASE: no workspace context (local-only)"), { code: "NO_DATABASE" });
    }
    return workspaceFakeDb(workspaceId);
  },
  dbScopeKey: () => "global",
  isDatabaseConfigured: () => true,
  // THR-025: mirror the real predicate so ctx.workspaceId misses fail closed
  // in tests exactly like production (dbForWorkspace throws NO_DATABASE).
  isNoDatabaseError: (err: unknown): boolean =>
    Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "NO_DATABASE",
  isConnectionError: () => false,
  noteDbFailure: () => {},
  noteDbSuccess: () => {},
  resolveTier: () => ({ tier: "dual", url: "mock" }),
  withStoreFallback: async (_ctx: unknown, dbOp: () => Promise<unknown>) => dbOp(),
  dualWrite: async ({ pgWrite, localWrite }: { pgWrite: () => Promise<unknown>; localWrite: () => Promise<unknown> }) => {
    await pgWrite();
    return localWrite();
  },
  __socketTestDb: {
    store,
    reset() {
      store.apiKeys.length = 0;
      store.messages.length = 0;
      store.channels.length = 0;
      store.workspaces.length = 0;
      store.agents.length = 0;
      boundCalls.length = 0;
      lastBoundDb = null;
      currentBoundDb = null;
      fakeAlsEnabled = false;
      workspaceDbResolver = null;
      workspaceDbHandles.clear();
    },
    setWorkspaceDbResolver(fn: ((workspaceId: string) => Promise<unknown> | unknown) | null) {
      workspaceDbResolver = fn;
    },
    setFakeAls(enabled: boolean) {
      fakeAlsEnabled = enabled;
      if (!enabled) currentBoundDb = null;
    },
    get lastBoundDb() {
      return lastBoundDb;
    },
    boundCalls,
  },
  };
});

vi.mock("./channels/channel-gate.js", async (importOriginal) => {
  if (process.env.__SOCKET_FAKE_DB__ !== "1") {
    return await importOriginal<Record<string, unknown>>();
  }
  return {
  channelGate: {
    // C3 slice 2: production mount resolution now reads through this gate,
    // so the fake reads through to the fake store (override still wins).
    get: async (id: string) =>
      channelOverride ? channelOverride(id) : (store.channels.find((c) => c.id === id) ?? null),
    categoryExists: async () => false,
    getCategory: async () => null,
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => ({}),
    // §6-8 pins: unset in socket tests (Auto + hierarchy defaults).
    getSettings: async () => null,
    updateSettings: async () => ({ settings: null }),
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
