// ART-13 regression guard (fix-artifacts-micro-13).
// The createArtifact emit site must type payload/opts against BrokerEventMap
// instead of double-casting `as never`: the payload literal is annotated as
// BrokerEventMap["artifact.created"] in artifacts-repository.ts, so a contract
// shape change fails tsc at the emit site (no cast can hide it anymore).
// Runtime guard here: emitted events carry exactly the contract keys, and only
// a STRING metadata.channelId is forwarded as opts.channelId — a non-string
// value is dropped instead of being passed through by a cast.
// Hermetic: DB boundary faked; workspace folder redirected to a temp dir; a
// real EventBroker instance is registered as the shared broker.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prevDatabaseUrl = process.env.DATABASE_URL;
  // Fallback for the real-module path: client construction is lazy, no I/O.
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/crowdos_artifacts_fix_test";
  return { prevDatabaseUrl, folder: null as string | null };
});

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config/database.js")>();
  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => [],
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => [v],
      }),
    }),
  };
  return { ...actual, getDb: () => fakeDb };
});

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  return {
    ...actual,
    resolveWorkspaceFolder: async () => h.folder,
    getWorkspaceRecord: async () => null,
  };
});

import { artifactsGate } from "./artifacts-gate.js";
import type { CreateArtifactInput } from "./artifacts-gate.js";
import { EventBroker, resetSharedBrokerForTests, setSharedBroker } from "../event-broker/event-broker-gate.js";
import type { BrokerEvent, BrokerEventMap } from "../event-broker/event-broker-gate.js";

// ART-13 compile-time pin: the expected payload literal itself must satisfy the
// BrokerEventMap contract. If the contract shape drifts (field renamed/removed),
// tsc fails here in addition to the repository emit site.
const EXPECTED_PAYLOAD: BrokerEventMap["artifact.created"] = {
  runId: "run-art13",
  artifactId: "art_placeholder",
  artifactType: "diff",
  workspaceId: "ws-art13",
};

const tempDirs: string[] = [];

async function freshFolder(): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "art13-"));
  tempDirs.push(dir);
  return dir;
}

function input(overrides: Partial<CreateArtifactInput> & Pick<CreateArtifactInput, "type">): CreateArtifactInput {
  return {
    runId: "run-art13",
    workspaceId: "ws-art13",
    producerAgent: "art-agent",
    contentRef: "artifact body",
    ...overrides,
  };
}

afterAll(async () => {
  resetSharedBrokerForTests();
  if (h.prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = h.prevDatabaseUrl;
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

describe("artifacts create - ART-13 typed emit contract", () => {
  it("emits BrokerEventMap-shaped payloads and forwards only a string channelId", async () => {
    h.folder = await freshFolder();
    const broker = new EventBroker();
    setSharedBroker(broker);
    const events: BrokerEvent[] = [];
    broker.onAny((e) => events.push(e));

    const diffRow = await artifactsGate.create(input({ type: "diff", metadata: { channelId: "ch-art13" } }));
    expect(events.map((e) => e.type)).toEqual(["diff.created", "artifact.updated"]);
    for (const e of events) {
      expect(e.payload).toEqual({ ...EXPECTED_PAYLOAD, artifactId: diffRow.id, artifactType: "diff" });
      expect(e.channelId).toBe("ch-art13");
    }

    events.length = 0;
    const reportRow = await artifactsGate.create(input({ type: "report", metadata: { channelId: 123 } }));
    expect(events.map((e) => e.type)).toEqual(["artifact.created", "artifact.updated"]);
    for (const e of events) {
      expect(e.payload).toEqual({ ...EXPECTED_PAYLOAD, artifactId: reportRow.id, artifactType: "report" });
      // Non-string channelId must not leak through the typed opts (old cast
      // would have forwarded 123 as never).
      expect(e.channelId).toBeUndefined();
    }
  });
});
