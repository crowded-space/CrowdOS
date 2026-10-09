import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJsonlIfAbsentById,
  localStoreDirsForTests,
  readJsonl,
  setLocalStoreDirForTests,
} from "./local-file.js";

let dir: string;
let previousLocalStoreDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-local-file-"));
  previousLocalStoreDir = process.env.CROWDOS_LOCALSTORE_DIR;
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  if (previousLocalStoreDir === undefined) delete process.env.CROWDOS_LOCALSTORE_DIR;
  else process.env.CROWDOS_LOCALSTORE_DIR = previousLocalStoreDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("appendJsonlIfAbsentById", () => {
  it("atomically appends only one row for concurrent writes with the same id", async () => {
    const writes = Array.from({ length: 32 }, (_, index) =>
      appendJsonlIfAbsentById("channel-a", {
        id: "message-a",
        channelId: "channel-a",
        workspaceId: "workspace-a",
        writer: index,
      }, "workspace-a"),
    );

    const results = await Promise.all(writes);
    const rows = await readJsonl("channel-a", "workspace-a");
    const storedRows = new Set(results.map((result) => JSON.stringify(result.row)));

    expect(results.filter((result) => result.appended)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(storedRows).toHaveLength(1);
    expect(results.map((result) => result.row)).toEqual(Array(32).fill(rows[0]));
    expect(results.every((result) => result.row.id === "message-a")).toBe(true);
  });

  it("does not suppress a same-id row from another raw channel sharing the sanitized filename", async () => {
    const fromColonChannel = await appendJsonlIfAbsentById(
      "channel:a",
      { id: "message-collision", channelId: "channel:a", workspaceId: "workspace-a", body: "colon" },
      "workspace-a",
    );
    const fromQuestionChannel = await appendJsonlIfAbsentById(
      "channel?a",
      { id: "message-collision", channelId: "channel?a", workspaceId: "workspace-a", body: "question" },
      "workspace-a",
    );

    expect(fromColonChannel.appended).toBe(true);
    expect(fromQuestionChannel.appended).toBe(true);
    expect(await readJsonl("channel:a", "workspace-a")).toEqual([
      fromColonChannel.row,
      fromQuestionChannel.row,
    ]);
  });

  it("keeps duplicate ids distinct between workspaces under the shared store override", async () => {
    setLocalStoreDirForTests(null);
    process.env.CROWDOS_LOCALSTORE_DIR = dir;

    const fromA = await appendJsonlIfAbsentById(
      "channel-a",
      { id: "message-shared", channelId: "channel-a", workspaceId: "workspace-a", body: "A" },
      "workspace-a",
    );
    const fromB = await appendJsonlIfAbsentById(
      "channel-a",
      { id: "message-shared", channelId: "channel-a", workspaceId: "workspace-b", body: "B" },
      "workspace-b",
    );
    const retryA = await appendJsonlIfAbsentById(
      "channel-a",
      { id: "message-shared", channelId: "channel-a", workspaceId: "workspace-a", body: "retry" },
      "workspace-a",
    );

    expect(fromA).toEqual({
      appended: true,
      row: { id: "message-shared", channelId: "channel-a", workspaceId: "workspace-a", body: "A" },
    });
    expect(fromB).toEqual({
      appended: true,
      row: { id: "message-shared", channelId: "channel-a", workspaceId: "workspace-b", body: "B" },
    });
    expect(retryA).toEqual({ appended: false, row: fromA.row });
    expect(await readJsonl("channel-a", "workspace-a")).toHaveLength(2);
  });

  it("terminates a torn message tail before appending a new row", async () => {
    const file = join(localStoreDirsForTests("workspace-a").crowdos, "messages", "channel-a.jsonl");
    mkdirSync(join(localStoreDirsForTests("workspace-a").crowdos, "messages"), { recursive: true });
    writeFileSync(file, '{"id":"torn-fragment"', "utf8");

    const result = await appendJsonlIfAbsentById(
      "channel-a",
      { id: "message-after-torn-tail", channelId: "channel-a", workspaceId: "workspace-a" },
      "workspace-a",
    );

    expect(result.appended).toBe(true);
    expect(await readJsonl("channel-a", "workspace-a")).toEqual([result.row]);
  });
});
