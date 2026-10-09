import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { messageGate } from "./message-gate.js";
import { env } from "../shared/config/env.js";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";

const previousDatabaseUrl = env.DATABASE_URL;
const storeDirs: string[] = [];

afterEach(() => {
  (env as any).DATABASE_URL = previousDatabaseUrl;
  setLocalStoreDirForTests(null);
  for (const dir of storeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepareLocalStore() {
  const dir = mkdtempSync(join(tmpdir(), "crowdos-msg-retry-"));
  storeDirs.push(dir);
  setLocalStoreDirForTests(dir);
  (env as any).DATABASE_URL = undefined;
}

function input(id: string, content: string) {
  return {
    id,
    channelId: "retry-channel",
    workspaceId: "ws-retry",
    authorId: "user-1",
    authorName: "User",
    authorLevel: "1",
    authorType: "user" as const,
    content,
  };
}

describe("MSG-031 · Local append retries are idempotent", () => {
  it("returns the persisted row and emits/reserves only once for sequential retries", async () => {
    prepareLocalStore();
    const broker = new EventBroker();
    const emitted: any[] = [];
    broker.on("message:new", undefined, (event) => emitted.push(event));

    const original = await messageGate.append(input("msg-retry-sequential", "original"), { broker });
    const retry = await messageGate.append(input("msg-retry-sequential", "retry payload"), { broker });
    const page = await messageGate.getChannelMessagesPage("retry-channel", {
      limit: 10,
    });

    expect(retry).toEqual(original);
    expect(page.messages).toEqual([expect.objectContaining({
      id: original.id,
      content: "original",
      sequenceNumber: original.sequenceNumber,
    })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual(original);

    const next = await messageGate.append(input("msg-retry-next", "next"));
    expect(next.sequenceNumber).toBe(original.sequenceNumber + 1);
  });

  it("serializes concurrent same-ID retries before sequence reservation and emission", async () => {
    prepareLocalStore();
    const broker = new EventBroker();
    const emitted: any[] = [];
    broker.on("message:new", undefined, (event) => emitted.push(event));

    const [first, second] = await Promise.all([
      messageGate.append(input("msg-retry-concurrent", "first"), { broker }),
      messageGate.append(input("msg-retry-concurrent", "second"), { broker }),
    ]);
    const page = await messageGate.getChannelMessagesPage("retry-channel", {
      limit: 10,
    });

    expect(first).toEqual(second);
    expect(page.messages).toEqual([expect.objectContaining({
      id: first.id,
      content: first.content,
      sequenceNumber: first.sequenceNumber,
    })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual(first);
  });
});
