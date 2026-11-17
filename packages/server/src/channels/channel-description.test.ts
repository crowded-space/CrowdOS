// UI audit §2.14: the create form collected a topic description, but the
// channel domain had no description field — the value was dropped and the
// client showed a shared placeholder instead. The field now round-trips
// through create, update (clear via null) and reads on both tiers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// Local tier: no DATABASE_URL for the real tier resolution (same contract as
// channel-local-mode.test.ts).
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { channelGate } from "./channel-gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-channel-desc-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

const WS = "ws-topic";

describe("channel topic description (audit §2.14)", () => {
  it("persists the description given at create", async () => {
    const created = await channelGate.create(
      {
        name: "qa-temp",
        description: "QA audit temp channel",
        type: "standard",
        createdBy: "user",
        categoryId: null,
        position: 0,
      } as any,
      undefined,
      WS,
    );

    expect("channel" in created).toBe(true);
    expect((created as any).channel.description).toBe("QA audit temp channel");

    const fetched = await channelGate.get((created as any).channel.id);
    expect(fetched?.description).toBe("QA audit temp channel");
  });

  it("updates the description and clears it with null", async () => {
    const created = await channelGate.create(
      { name: "topic-edit", type: "standard", createdBy: "user", categoryId: null, position: 0 } as any,
      undefined,
      WS,
    );
    const id = (created as any).channel.id;

    const renamed = await channelGate.update(id, { description: "Renamed topic" } as any);
    expect((renamed as any).channel?.description).toBe("Renamed topic");

    const cleared = await channelGate.update(id, { description: null } as any);
    expect((cleared as any).channel?.description).toBeNull();
  });

  it("keeps legacy rows without a description key readable", async () => {
    // Rows written before migration 0030 carry no description key at all.
    const { localStoreDirsForTests } = await import("../shared/core/local-file.js");
    const { crowdos } = localStoreDirsForTests(WS);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(crowdos, { recursive: true });
    writeFileSync(
      join(crowdos, "channels.json"),
      JSON.stringify([
        {
          id: "ch-legacy",
          categoryId: null,
          workspaceId: WS,
          folderPath: null,
          name: "legacy-row",
          type: "standard",
          createdBy: "user",
          position: 0,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          archivedReason: null,
        },
      ]),
      "utf8",
    );

    const fetched = await channelGate.get("ch-legacy");
    expect(fetched?.name).toBe("legacy-row");
    expect(fetched?.description).toBeUndefined();

    // A description-less positional update must not invent one.
    const renamed = await channelGate.update("ch-legacy", { position: 1 } as any);
    expect((renamed as any).channel?.name).toBe("legacy-row");
    expect((renamed as any).channel?.description).toBeUndefined();
  });
});
