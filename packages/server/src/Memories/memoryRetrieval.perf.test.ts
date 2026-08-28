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

import { memTestStore, resetMemTestStore } from "./memoryTestDb.js";
import { retrieveMemoryCandidates } from "./memoryRetrieval.js";
import { memorySessionDiscards } from "./memorySessionDiscards.js";

const AGENT = "22222222-2222-2222-2222-222222222222";
const CHANNEL = "perf-test-mem";

let savedWindowEnv: string | undefined;

function makeNote(i: number): Record<string, unknown> {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  return {
    id: `note-${String(i).padStart(6, "0")}`,
    agentId: AGENT,
    channelId: CHANNEL,
    noteType: i % 3 === 0 ? "episodic" : "semantic",
    noteTimestamp: new Date(base + i * 1000),
    importanceScore: (i % 100) / 100,
    confidence: "high",
    sourceType: "direct_experience",
    emotionalValence: "neutral",
    accessCount: 0,
    lastAccessed: null,
    links: i % 5 === 0 ? ["linked-note"] : [],
    contradictionFlags: i % 7 === 0 ? ["tension"] : [],
    lifecycleStatus: "active",
    archivedAt: null,
    archiveReason: null,
    suppressedAt: null,
    suppressReason: null,
    suppressUntil: null,
    hook: `hook ${i}`,
    brief: `brief ${i}`,
    observed: "",
    interpreted: "",
    feltSense: "",
    futureRelevance: "",
    uncertainty: "",
    detailed: "",
    createdAt: new Date(base),
    updatedAt: new Date(base),
  };
}

function seedNotes(count: number): void {
  for (let i = 0; i < count; i++) memTestStore.notes.push(makeNote(i));
}

function retrievalInput(topK = 10) {
  return {
    agentId: AGENT,
    channelId: CHANNEL,
    userMessageText: "probe",
    recentEpisodic: true,
    highImportance: true,
    mentions: true,
    unresolvedTensions: true,
    recencyBump: false,
    topK,
  };
}

describe("PERF-2 · bounded memory retrieval window", () => {
  beforeEach(() => {
    resetMemTestStore();
    memorySessionDiscards.clearAll();
    savedWindowEnv = process.env.MEM_RETRIEVAL_WINDOW;
    delete process.env.MEM_RETRIEVAL_WINDOW;
  });

  afterEach(() => {
    if (savedWindowEnv === undefined) delete process.env.MEM_RETRIEVAL_WINDOW;
    else process.env.MEM_RETRIEVAL_WINDOW = savedWindowEnv;
  });

  it("issues exactly ONE notes query per retrieval regardless of note count", async () => {
    seedNotes(200);
    await retrieveMemoryCandidates(retrievalInput());
    expect(memTestStore.dbCalls).toBe(1);

    resetMemTestStore();
    seedNotes(5000);
    await retrieveMemoryCandidates(retrievalInput());
    expect(memTestStore.dbCalls).toBe(1);
  });

  it("candidates are drawn only from the top scored-proxy window (importance DESC, timestamp DESC)", async () => {
    seedNotes(5000);
    const candidates = await retrieveMemoryCandidates(retrievalInput(10));

    const windowIds = new Set(
      [...memTestStore.notes]
        .sort((a, b) => {
          const imp = Number(b.importanceScore) - Number(a.importanceScore);
          if (imp !== 0) return imp;
          return new Date(b.noteTimestamp as Date).getTime() - new Date(a.noteTimestamp as Date).getTime();
        })
        .slice(0, 60)
        .map((n) => n.id as string),
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(10);
    for (const c of candidates) {
      expect(windowIds.has(c.noteId)).toBe(true);
    }
  });

  it("MEM_RETRIEVAL_WINDOW env tightens the SQL-side candidate set", async () => {
    process.env.MEM_RETRIEVAL_WINDOW = "5";
    seedNotes(5000);

    const candidates = await retrieveMemoryCandidates(retrievalInput(10));

    const top5Ids = new Set(
      [...memTestStore.notes]
        .sort((a, b) => {
          const imp = Number(b.importanceScore) - Number(a.importanceScore);
          if (imp !== 0) return imp;
          return new Date(b.noteTimestamp as Date).getTime() - new Date(a.noteTimestamp as Date).getTime();
        })
        .slice(0, 5)
        .map((n) => n.id as string),
    );

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(top5Ids.has(c.noteId)).toBe(true);
    }
    expect(memTestStore.dbCalls).toBe(1);
  });

  it("output shape stays byte-compatible: all MemoryCandidate fields populated", async () => {
    seedNotes(120);
    const candidates = await retrieveMemoryCandidates(retrievalInput());

    for (const c of candidates) {
      expect(typeof c.noteId).toBe("string");
      expect(typeof c.hook).toBe("string");
      expect(typeof c.brief).toBe("string");
      expect(typeof c.noteType).toBe("string");
      expect(c.noteTimestamp).toBeInstanceOf(Date);
      expect(typeof c.importanceScore).toBe("number");
      expect(typeof c.confidence).toBe("string");
      expect(Array.isArray(c.contradictionFlags)).toBe(true);
      expect(typeof c.score).toBe("number");
      expect(Object.keys(c.laneScores).length).toBeGreaterThan(0);
      expect(Array.isArray(c.sourceLanes)).toBe(true);
      expect(c.sourceLanes.length).toBeGreaterThan(0);
    }
  });
});
