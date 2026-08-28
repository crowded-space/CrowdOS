import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../Shared/config/database.js", async () => {
  const { buildMemTestDb, memTestStore } = await import("./memoryTestDb.js");
  return {
    getDb: () => buildMemTestDb(),
    getSqlClient: () => {
      throw new Error("getSqlClient is not available under the memory test fake");
    },
    ensurePgVectorExtension: async () => {},
    closeDatabaseConnection: async () => {},
    __memTestStoreRef: memTestStore,
  };
});

vi.mock("../Shared/sockets/registerSocketServer.js", () => ({
  globalBroker: null,
}));

vi.mock("../tools/safety/Guard.js", () => ({
  Guard: { validatePath: () => "/tmp/memtest" },
}));

vi.mock("../tools/safety/hardenedExec.js", () => ({
  execHardened: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
}));

vi.mock("../Agents/agentGate.js", () => ({
  AgentSpawnManager: class {},
}));

import { memTestStore, resetMemTestStore, tick } from "./memoryTestDb.js";
import { memoriesGate } from "./memoriesGate.js";
import { resetMemorySweeperForTests } from "./memoryLifecycle.js";
import type { MemoryStoreResult } from "./memoriesGate.js";
import { toolsGate } from "../tools/toolsGate.js";

function assertOk<T>(result: MemoryStoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

const AGENT = "11111111-1111-1111-1111-111111111111";
const CHANNEL = "ch-1";

const ENV_KEYS = [
  "MEM_NOTE_CAP",
  "MEM_SUPPRESS_SWEEP_MS",
  "MEM_DISCARD_TTL_MS",
  "MEM_REFLECT_THROTTLE",
  "MEM_REFLECT_MIN_INTERVAL_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function seedBase(): void {
  memTestStore.agents.push({
    id: AGENT,
    name: "raven",
    title: "Raven",
    status: "idle",
  });
  memTestStore.channels.push({ id: CHANNEL, name: "general" });
}

function makeNote(overrides: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  const now = new Date();
  return {
    id: `2026-01-01-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    agentId: AGENT,
    channelId: CHANNEL,
    noteType: "episodic",
    noteTimestamp: now,
    importanceScore: 0.9,
    confidence: "high",
    sourceType: "direct_experience",
    emotionalValence: "neutral",
    accessCount: 0,
    lastAccessed: null,
    links: [],
    contradictionFlags: [],
    lifecycleStatus: "active",
    archivedAt: null,
    archiveReason: null,
    suppressedAt: null,
    suppressReason: null,
    suppressUntil: null,
    hook: "seed hook",
    brief: "seed brief",
    observed: "",
    interpreted: "",
    feltSense: "",
    futureRelevance: "",
    uncertainty: "",
    detailed: "",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function retrievalInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT,
    channelId: CHANNEL,
    userMessageText: "anything",
    recentEpisodic: true,
    highImportance: true,
    mentions: false,
    unresolvedTensions: false,
    recencyBump: false,
    topK: 10,
    ...overrides,
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  resetMemTestStore();
  resetMemorySweeperForTests();
  memoriesGate.sessionDiscards.clearAll();
  memoriesGate.reflectionThrottle.reset();
  seedBase();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("MEM-1c · note-id generation without table scan", () => {
  it("produces Continuum-lineage date-prefixed unique ids", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(await memoriesGate.generateNoteId(AGENT));
    }
    expect(ids.size).toBe(5000);
    const sample = ids.values().next().value as string;
    expect(sample).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/);
  });

  it("does not query the database", async () => {
    const before = memTestStore.dbCalls;
    await memoriesGate.generateNoteId(AGENT);
    expect(memTestStore.dbCalls).toBe(before);
  });

  it("stays compatible with stored references (opaque text primary key)", async () => {
    const legacy = makeNote({ id: "2026-05-30-001" });
    memTestStore.notes.push(legacy);
    const result = await memoriesGate.readMemoryNote("raven", legacy.id as string);
    expect(result.ok).toBe(true);
  });
});

describe("MEM-1a · suppression expiry enforcement", () => {
  it("retrieval excludes notes whose suppress_until is still active", async () => {
    const clean = makeNote({ id: "2026-02-01-c00000000000" });
    const softSuppressed = makeNote({
      id: "2026-02-01-s00000000000",
      suppressUntil: new Date(Date.now() + 60 * 60 * 1000),
      suppressReason: "soft",
    });
    const hardExpired = makeNote({
      id: "2026-02-01-e00000000000",
      lifecycleStatus: "suppressed",
      suppressUntil: new Date(Date.now() - 60 * 60 * 1000),
    });
    memTestStore.notes.push(clean, softSuppressed, hardExpired);

    const candidates = await memoriesGate.retrieveMemoryCandidates(retrievalInput());
    const ids = candidates.map((c) => c.noteId);
    expect(ids).toContain(clean.id);
    expect(ids).not.toContain(softSuppressed.id);
    expect(ids).not.toContain(hardExpired.id);
  });

  it("default listing hides actively-suppressed notes; explicit includeSuppressed overrides", async () => {
    const clean = makeNote({ id: "2026-02-02-c00000000000" });
    const softSuppressed = makeNote({
      id: "2026-02-02-s00000000000",
      suppressUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    memTestStore.notes.push(clean, softSuppressed);

    const def = assertOk(await memoriesGate.listMemoryPreviews("raven"));
    expect(def.map((n) => n.id)).toEqual([clean.id]);

    const admin = assertOk(await memoriesGate.listMemoryPreviews("raven", { includeSuppressed: true }));
    expect(admin.map((n) => n.id).sort()).toEqual([clean.id, softSuppressed.id].sort());
  });
});

describe("MEM-1a · periodic suppression sweep", () => {
  it("flips expired suppressions back to active and logs the flip", async () => {
    const past = makeNote({
      id: "2026-03-01-p00000000000",
      lifecycleStatus: "suppressed",
      suppressUntil: new Date(Date.now() - 1000),
      suppressReason: "old block",
    });
    const future = makeNote({
      id: "2026-03-01-f00000000000",
      lifecycleStatus: "suppressed",
      suppressUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    memTestStore.notes.push(past, future);

    const result = await memoriesGate.runMemorySweep();
    await tick();

    expect(result.flipped).toBe(1);

    const pastRow = memTestStore.notes.find((n) => n.id === past.id)!;
    expect(pastRow.lifecycleStatus).toBe("active");
    expect(pastRow.suppressUntil).toBeNull();

    const futureRow = memTestStore.notes.find((n) => n.id === future.id)!;
    expect(futureRow.lifecycleStatus).toBe("suppressed");

    const flipLogs = memTestStore.log.filter(
      (l) => l.action === "suppress_expire" && l.noteId === past.id,
    );
    expect(flipLogs.length).toBe(1);
    expect(flipLogs[0].agentId).toBe(AGENT);
  });

  it("registers exactly once per process and honors MEM_SUPPRESS_SWEEP_MS", () => {
    process.env.MEM_SUPPRESS_SWEEP_MS = "12345";
    const captured: ReturnType<typeof setInterval>[] = [];
    const spy = vi.spyOn(global, "setInterval").mockImplementation(((fn: any, ms: number) => {
      void fn;
      const handle = { unref() {}, refresh() {} } as unknown as NodeJS.Timeout;
      (handle as any).__intervalMs = ms;
      captured.push(handle);
      return handle;
    }) as any);
    try {
      memoriesGate.startMemorySweeper();
      memoriesGate.startMemorySweeper();
      const sweeperTimers = captured.filter((t) => (t as any).__intervalMs === 12345);
      expect(sweeperTimers.length).toBe(1);
    } finally {
      spy.mockRestore();
      for (const handle of captured) clearInterval(handle as unknown as NodeJS.Timeout);
    }
  });
});

describe("MEM-1b · per-agent note cap", () => {
  it("archives oldest lowest-importance notes beyond cap and logs each", async () => {
    process.env.MEM_NOTE_CAP = "3";
    const t0 = new Date(Date.now() - 30_000);
    const t1 = new Date(Date.now() - 20_000);
    const t2 = new Date(Date.now() - 10_000);
    const high = makeNote({ id: "2026-04-01-h00000000000", importanceScore: 0.9, createdAt: t0 });
    const victim = makeNote({ id: "2026-04-01-v00000000000", importanceScore: 0.4, createdAt: t1 });
    const mid = makeNote({ id: "2026-04-01-m00000000000", importanceScore: 0.7, createdAt: t2 });
    memTestStore.notes.push(high, victim, mid);

    const created = assertOk(
      await memoriesGate.createMemoryNote({
        agentId: "raven",
        channelId: CHANNEL,
        noteType: "episodic",
        importanceScore: 0.6,
        hook: "brand new fact",
        brief: "pushes vault over cap",
      }),
    );
    await tick();
    await tick();

    const rows = memTestStore.notes;
    expect(rows.find((n) => n.id === victim.id)!.lifecycleStatus).toBe("archived");
    expect(rows.find((n) => n.id === victim.id)!.archiveReason).toBe("note_cap:3");
    for (const keep of [high, mid]) {
      expect(rows.find((n) => n.id === keep.id)!.lifecycleStatus).toBe("active");
    }
    expect(rows.find((n) => n.id === created.id)!.lifecycleStatus).toBe("active");

    const capLogs = memTestStore.log.filter(
      (l) => l.action === "cap_archive" && l.noteId === victim.id,
    );
    expect(capLogs.length).toBeGreaterThanOrEqual(1);
    expect(capLogs[0].agentId).toBe(AGENT);
  });

  it("archived notes are excluded from retrieval", async () => {
    const archived = makeNote({ id: "2026-04-02-a00000000000", lifecycleStatus: "archived" });
    const active = makeNote({ id: "2026-04-02-b00000000000" });
    memTestStore.notes.push(archived, active);

    const candidates = await memoriesGate.retrieveMemoryCandidates(retrievalInput());
    expect(candidates.map((c) => c.noteId)).toEqual([active.id]);
  });
});

describe("MEM-1d · creation/lifecycle logging", () => {
  it("writes create, update, archive and suppress entries with agent + action", async () => {
    const created = assertOk(
      await memoriesGate.createMemoryNote({
        agentId: "raven",
        channelId: CHANNEL,
        noteType: "semantic",
        hook: "log me",
        brief: "audit trail check",
      }),
    );
    await tick();

    let logs = memTestStore.log.filter((l) => l.noteId === created.id);
    expect(logs.some((l) => l.action === "create" && l.agentId === AGENT)).toBe(true);

    await memoriesGate.updateMemoryNote("raven", created.id, { reason: "tune", importanceScore: 0.8 });
    await memoriesGate.archiveMemoryNote("raven", created.id, "cleanup");
    await memoriesGate.suppressMemoryNote("raven", created.id, "temp hide", new Date(Date.now() + 1000));
    await tick();

    logs = memTestStore.log.filter((l) => l.noteId === created.id);
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("update");
    expect(actions).toContain("archive");
    expect(actions).toContain("suppress");
    for (const entry of logs) {
      expect(entry.agentId).toBe(AGENT);
      expect(entry.reason).toBeTruthy();
    }
  });
});

describe("MEM-1e · reflection throttle", () => {
  it("similarity helpers behave (jaccard + normalization)", () => {
    expect(memoriesGate.jaccardSimilarity(["alpha", "beta"], ["alpha", "beta"])).toBe(1);
    expect(memoriesGate.jaccardSimilarity(["alpha"], ["omega"])).toBe(0);
    expect(memoriesGate.normalizeHookTokens("The Alpha-Beta, shipped!")).toEqual(["alpha", "beta", "shipped"]);
  });

  it("throttles multiple reflection notes within the min interval", async () => {
    process.env.MEM_REFLECT_MIN_INTERVAL_MS = "60000";

    const first = await memoriesGate.createMemoryNote({
      agentId: "raven",
      channelId: CHANNEL,
      noteType: "reflection",
      sourceType: "self_reflection",
      hook: "First reflection about deployment flow",
      brief: "one",
    });
    expect(first.ok).toBe(true);

    const second = await memoriesGate.createMemoryNote({
      agentId: "raven",
      channelId: CHANNEL,
      noteType: "reflection",
      sourceType: "self_reflection",
      hook: "Second reflection about unrelated topic entirely",
      brief: "two",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("REFLECTION_THROTTLED");
  });

  it("deduplicates near-identical hooks even outside the interval window", async () => {
    process.env.MEM_REFLECT_MIN_INTERVAL_MS = "1";

    const first = await memoriesGate.createMemoryNote({
      agentId: "raven",
      channelId: CHANNEL,
      noteType: "reflection",
      sourceType: "self_reflection",
      hook: "Deployment pipeline broke because tests failed unexpectedly today",
      brief: "one",
    });
    expect(first.ok).toBe(true);
    await tick(15);

    const dup = await memoriesGate.createMemoryNote({
      agentId: "raven",
      channelId: CHANNEL,
      noteType: "reflection",
      sourceType: "self_reflection",
      hook: "deployment pipeline broke because tests failed unexpectedly today!",
      brief: "dupe",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("REFLECTION_DUPLICATE");
  });

  it("MEM_REFLECT_THROTTLE=false disables throttling and dedupe", async () => {
    process.env.MEM_REFLECT_THROTTLE = "false";
    process.env.MEM_REFLECT_MIN_INTERVAL_MS = "60000";

    const payload = {
      agentId: "raven",
      channelId: CHANNEL,
      noteType: "reflection" as const,
      sourceType: "self_reflection" as const,
      hook: "Same hook repeated over and over again here",
      brief: "same",
    };
    const first = await memoriesGate.createMemoryNote(payload);
    const second = await memoriesGate.createMemoryNote(payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("non-reflection writes are never throttled", async () => {
    process.env.MEM_REFLECT_MIN_INTERVAL_MS = "60000";
    for (const hook of ["episodic one", "episodic two"]) {
      const result = await memoriesGate.createMemoryNote({
        agentId: "raven",
        channelId: CHANNEL,
        noteType: "episodic",
        hook,
        brief: hook,
      });
      expect(result.ok).toBe(true);
    }
  });
});

describe("MEM-2 · discard_memory_from_context", () => {
  function discardHandler() {
    const definition = toolsGate.get("discard_memory_from_context");
    expect(definition).toBeDefined();
    return definition!.handler;
  }

  it("marks the note discarded for the session, persists a short soft-suppress, and previews exclude it", async () => {
    process.env.MEM_DISCARD_TTL_MS = "30000";
    const note = makeNote({ id: "2026-05-01-d00000000000", hook: "discard target", brief: "target brief" });
    const keeper = makeNote({ id: "2026-05-01-k00000000000" });
    memTestStore.notes.push(note, keeper);

    const handler = discardHandler();
    const result = await handler(
      { note_id: note.id, reason: "not relevant right now" },
      { agentId: AGENT, channelId: CHANNEL } as any,
    );
    expect(result.success).toBe(true);

    expect(memoriesGate.sessionDiscards.listDiscarded(AGENT, CHANNEL)).toContain(note.id);

    const row = memTestStore.notes.find((n) => n.id === note.id)!;
    expect(row.lifecycleStatus).toBe("active");
    expect(row.suppressUntil).toBeInstanceOf(Date);
    const ttl = (row.suppressUntil as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);

    const candidates = await memoriesGate.retrieveMemoryCandidates(retrievalInput());
    expect(candidates.map((c) => c.noteId)).not.toContain(note.id);
    expect(candidates.map((c) => c.noteId)).toContain(keeper.id);

    const previewBlock = memoriesGate.buildMemoryPreviewBlock(candidates);
    expect(previewBlock).not.toContain(note.id);
  });

  it("session discard alone is enough to hide a note from subsequent previews", async () => {
    const note = makeNote({ id: "2026-05-02-x00000000000" });
    memTestStore.notes.push(note);

    memoriesGate.sessionDiscards.discard(AGENT, CHANNEL, [note.id]);
    const candidates = await memoriesGate.retrieveMemoryCandidates(retrievalInput());
    expect(candidates.map((c) => c.noteId)).not.toContain(note.id);
  });

  it("still records a session discard for unknown vault notes", async () => {
    const handler = discardHandler();
    const result = await handler(
      { note_id: "2099-12-31-zzzzzzzzzzzz", reason: "ghost" },
      { agentId: AGENT, channelId: CHANNEL } as any,
    );
    expect(result.success).toBe(true);
    expect(memoriesGate.sessionDiscards.listDiscarded(AGENT, CHANNEL)).toContain("2099-12-31-zzzzzzzzzzzz");
  });

  it("fails cleanly without execution context", async () => {
    const handler = discardHandler();
    const result = await handler({ note_id: "x" }, undefined as any);
    expect(result.success).toBe(false);
  });
});

describe("timer registration site", () => {
  it("startHeartbeatSystem starts the memory sweeper alongside heartbeat timers", async () => {
    process.env.MEM_SUPPRESS_SWEEP_MS = "7777777";
    const { startHeartbeatSystem } = await import("../Shared/core/agentHeartbeat.js");
    const captured: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(global, "setInterval").mockImplementation(((fn: any, ms: number) => {
      void fn;
      const handle = { unref() {}, refresh() {} } as unknown as NodeJS.Timeout;
      (handle as any).__intervalMs = ms;
      captured.push(handle);
      return handle;
    }) as any);
    try {
      startHeartbeatSystem({ emit() {} } as any);
      startHeartbeatSystem({ emit() {} } as any);
      const sweeperTimers = captured.filter((t) => (t as any).__intervalMs === 7777777);
      expect(sweeperTimers.length).toBe(1);
      expect(captured.length).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
      for (const handle of captured) clearInterval(handle);
    }
  });
});
