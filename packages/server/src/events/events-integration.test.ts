// §29 end-to-end: a real local chat turn (no DATABASE_URL) must leave a
// replayable event trail on disk, and the replay endpoint must serve it.
//
// This is the test that proves the hook is actually WIRED — the unit tests
// attach their own subscriber, so they would pass even if `create-app.ts`
// forgot to register one. Here the broker is the app's own shared instance and
// the events come from real runtime emits.
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

let dir: string;
let app: any;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-events-e2e-"));
  process.env.WORKSPACE_DIR = dir;
  process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = join(dir, "workspaces.json");
  const { writeFileSync } = await import("node:fs");
  const stamp = new Date().toISOString();
  const record = (id: string) => ({
    id, name: id, icon: "x", databaseUrl: "", rootPath: join(dir, id),
    screenLockPinHash: null, createdAt: stamp, updatedAt: stamp,
  });
  writeFileSync(
    join(dir, "workspaces.json"),
    JSON.stringify({ workspaces: [record("ws-events"), record("ws-events-2")] }),
  );
  setLocalStoreDirForTests(dir);
  const { buildServer } = await import("../create-app.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
}, 60_000);

afterAll(async () => {
  await stop?.();
  setLocalStoreDirForTests(null);
  delete process.env.WORKSPACE_DIR;
  delete process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
  (env as any).DATABASE_URL = prevDatabaseUrl;
  rmSync(dir, { recursive: true, force: true });
});

async function replay(channelId: string, afterSeq?: number, workspaceId?: string) {
  const q = afterSeq === undefined ? "" : `&afterSeq=${afterSeq}`;
  const res = await app.inject({
    method: "GET",
    url: `/api/events/recent?channelId=${encodeURIComponent(channelId)}${q}&limit=200`,
    remoteAddress: "127.0.0.1",
    headers: workspaceId ? { "x-workspace-id": workspaceId } : {},
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { channelId: string; events: any[]; lastSeq: number };
}

/** Poll until the detached log hook has landed at least `min` events. */
async function waitForEvents(channelId: string, min: number, workspaceId?: string) {
  let body = await replay(channelId, undefined, workspaceId);
  for (let i = 0; i < 200 && body.events.length < min; i++) {
    await new Promise((r) => setTimeout(r, 10));
    body = await replay(channelId, undefined, workspaceId);
  }
  return body;
}

/**
 * Poll until the channel head stops advancing. The append hook is detached, so
 * a fixed sleep would be either flaky or slow; observing the head settle is the
 * deterministic way to know the turn’s log writes have all landed.
 */
async function waitForStableHead(channelId: string, workspaceId?: string) {
  let body = await replay(channelId, undefined, workspaceId);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const next = await replay(channelId, undefined, workspaceId);
    if (next.lastSeq === body.lastSeq) return next;
    body = next;
  }
  return body;
}

describe("§29 event log · end-to-end local turn", () => {
  it("records a real assistant turn and replays it through the endpoint", async () => {
    const { channelGate } = await import("../channels/channel-gate.js");
    const { agentRegistry } = await import("../agents/agent-service.js");
    const { localSeedDefaultAgent } = await import("../agents/agent-local-store.js");
    const { runtimeGate } = await import("../runtime/runtime-gate.js");
    const { ProviderRegistry } = await import("../runtime/providers/provider-registry.js");
    const { messageGate } = await import("../messages/message-gate.js");

    const cat = await channelGate.createCategory({
      name: "General", workspaceId: "ws-events", createdBy: "system", position: 0,
    });
    const created = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
      undefined,
      "ws-events",
    );
    const channelId = (created as any).channel.id;
    const { localUpsertModelModule } = await import("../modules/module-local-store.js");
    const { localUpsertAgent } = await import("../agents/agent-local-store.js");
    const now = new Date().toISOString();
    await localUpsertModelModule(
      {
        id: "mod-events-google",
        label: "events test model",
        provider: "google",
        modelName: "gemini-2.0-flash",
        apiKey: null,
        endpointUrl: null,
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 2048,
        stopSequences: [],
        maxRecentMessages: 10,
        enableCompression: true,
        compressionThreshold: 15,
        createdAt: now,
        updatedAt: now,
      } as any,
      "ws-events",
    );
    const agent = await localUpsertAgent({
      id: "agent-events-default",
      workspaceId: "ws-events",
      name: "default-assistant",
      title: "Default Assistant",
      authorityLevel: 1,
      modelModuleId: "mod-events-google",
      instructionModuleId: "instr-default",
      memorySharingPolicy: "full",
      status: "idle",
      isTemplate: false,
    });

    ProviderRegistry.register({
      provider: "google",
      supportsStreaming: false,
      supportsTools: false,
      async call(_config: any, req: any) {
        return {
          content: `echo: ${req.userPrompt}`,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          finishReason: "stop",
        };
      },
    });

    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const sharedBroker = getSharedBroker();
    expect(sharedBroker).not.toBeNull();
    const broker = sharedBroker!;

    // Same shape the socket path uses: the append gets the broker, so the user
    // turn emits `message:new` and therefore appears in the log. (A message
    // written without a broker emits nothing and leaves no event — a real
    // property of the log, recorded in the domain spec's Gaps.)
    await messageGate.append(
      {
        channelId, authorId: "user-1", authorName: "Tester", authorLevel: "stakeholder",
        authorType: "user", content: "hello event log",
      },
      { broker },
    );

    const result = await runtimeGate.execute({
      agent, channelId, workspaceId: "ws-events", userInput: "hello event log",
      broker, explicitRuntime: "conversational",
    });
    expect(result.status).toBe("completed");

    // The turn emitted message:new; the boot hook logged it. Wait for the
    // specific key rather than for "any event", because appends land one at a
    // time and a bare count would race the streaming events.
    let body = await replay(channelId, undefined, "ws-events");
    for (let i = 0; i < 200 && !body.events.some((e: any) => e.type === "message:new"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      body = await replay(channelId, undefined, "ws-events");
    }
    const types = body.events.map((e: any) => e.type);
    expect(types).toContain("message:new");
    expect(body.lastSeq).toBeGreaterThan(0);
    // The log is the channel's own file, not a shared bucket.
    // Canon: the log lives inside the owning workspace's vfs/.crowdos/events/.
    expect(
      existsSync(join(localStoreDirsForTests("ws-events").crowdos, "events", `${channelId}.jsonl`)),
    ).toBe(true);
    // Ephemeral streaming never lands, even though the turn streamed.
    expect(types).not.toContain("message:stream");

    // QUIESCE before comparing snapshots. The log hook is fire-and-forget by
    // design (a log write must never block or fail a turn), so the tail can
    // still be growing while this test runs. Comparing a snapshot taken at t1
    // against one taken at t2 would race the appends — so wait until the head
    // stops moving, then treat that as the settled state.
    body = await waitForStableHead(channelId, "ws-events");

    // Resuming from the head is empty-but-caught-up; resuming from 0 re-delivers.
    const fromHead = await replay(channelId, body.lastSeq, "ws-events");
    expect(fromHead.events).toEqual([]);
    expect(fromHead.lastSeq).toBe(body.lastSeq);
    const fromZero = await replay(channelId, 0, "ws-events");
    expect(fromZero.events.length).toBe(body.events.length);
    expect(fromZero.events.map((e: any) => e.seq)).toEqual(body.events.map((e: any) => e.seq));

    // Replay is ordered ascending and gap-free per channel.
    for (let i = 1; i < fromZero.events.length; i++) {
      expect(fromZero.events[i].seq).toBeGreaterThan(fromZero.events[i - 1].seq);
    }
    expect((await agentRegistry.getById(agent.id))?.status).toBe("idle");

    // The persisted message and the logged message:new agree — the log is not a
    // parallel universe, it is the same turn observed event-first.
    const logged = body.events.find((e: any) => e.type === "message:new");
    const page = await messageGate.getChannelMessagesPage(channelId, { limit: 10 });
    const persistedIds = page.messages.map((m: any) => m.id);
    expect(persistedIds).toContain(logged.payload.id);
  }, 60_000);

  it("writes one line per event with no torn tail after a full turn", async () => {
    const { channelGate } = await import("../channels/channel-gate.js");
    const cat = await channelGate.createCategory({
      name: "Second", workspaceId: "ws-events-2", createdBy: "system", position: 0,
    });
    const created = await channelGate.create(
      { name: "second", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
      undefined,
      "ws-events-2",
    );
    const channelId = (created as any).channel.id;
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = getSharedBroker()!;

    for (let i = 1; i <= 3; i++) {
      broker.emit("agent:status" as never, { agentId: "agent-1", channelId, status: "working" } as never, { channelId } as never);
    }
    const body = await waitForEvents(channelId, 3, "ws-events-2");
    expect(body.events.map((e: any) => e.seq)).toEqual([1, 2, 3]);

    const raw = readFileSync(
      join(localStoreDirsForTests("ws-events-2").crowdos, "events", `${channelId}.jsonl`),
      "utf8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 30_000);
});
