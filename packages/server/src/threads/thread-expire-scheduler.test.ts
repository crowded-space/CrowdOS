// THR-007: the thread TTL sweep used to exist only as a manual POST endpoint —
// expired threads never transitioned in any environment. This pins the landed
// scheduler shape end-to-end on the local tier (no DATABASE_URL):
//   1. the `thread-expire` repeatable is registered (60s cadence),
//   2. one maintenance tick flips an expired thread exactly once,
//   3. a repeat tick is idempotent (no re-flip, no error),
//   4. the `job.data.kind` fallback shape routes to the same handler.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// Local tier: the sweep's DB-less branch is the deterministic path here.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

import { channelGate } from "../channels/channel-gate.js";
import { REPEATABLES } from "../queue/repeatables.js";
import { maintenanceProcessor } from "../queue/maintenance-worker.js";
import { threadGate } from "./thread-gate.js";

let storeDir: string;
const prevWorkspaceDir = process.env.WORKSPACE_DIR;
const prevRegistryFile = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;

beforeAll(() => {
  storeDir = mkdtempSync(join(tmpdir(), "crowdos-thr007-"));
  process.env.WORKSPACE_DIR = storeDir;
  process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = join(storeDir, "workspaces.json");
  setLocalStoreDirForTests(storeDir);
});

afterAll(() => {
  setLocalStoreDirForTests(null);
  if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = prevWorkspaceDir;
  if (prevRegistryFile === undefined) delete process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
  else process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = prevRegistryFile;
  (env as any).DATABASE_URL = prevDatabaseUrl;
  rmSync(storeDir, { recursive: true, force: true });
});

async function seedChannelWithExpiredThread(): Promise<{ channelId: string; threadId: string }> {
  const cat = await channelGate.createCategory({ name: "General", workspaceId: "ws-local", createdBy: "test" });
  const ch = await channelGate.create(
    { name: "general", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
    undefined,
    "ws-local",
  );
  const channelId = (ch as any).channel?.id ?? (ch as any).id;
  expect(channelId).toBeTruthy();
  const created = await threadGate.create({ channelId, createdBy: "test", isEphemeral: true, ttlHours: 1 });
  const threadId = (created as any).thread.id as string;
  // Force expiry by rewriting the local row's expiresAt into the past (the
  // local tier has no clock seam; this is the honest way to age a row).
  const file = join(storeDir, "ws-local", "vfs", ".crowdos", "threads", `${channelId}.json`);
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.id === threadId);
  expect(row).toBeTruthy();
  row!.expiresAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return { channelId, threadId };
}

describe("THR-007 thread-expire scheduler", () => {
  it("registers the thread-expire repeatable at a 60s cadence", () => {
    const spec = REPEATABLES.find((r) => r.id === "thread-expire");
    expect(spec).toBeTruthy();
    expect(spec!.name).toBe("thread-expire");
    expect(spec!.everyMs).toBe(60_000);
  });

  it("flips an expired thread within one maintenance tick and stays idempotent", async () => {
    const { threadId } = await seedChannelWithExpiredThread();

    await maintenanceProcessor({ name: "thread-expire", data: { kind: "thread-expire" } } as never);
    const after = await threadGate.get(threadId);
    expect((after as any).status).toBe("expired");
    expect((after as any).archivedAt).toBeTruthy();

    // Idempotency: nothing left to archive, and a repeat tick is a no-op.
    expect(await threadGate.archiveExpired()).toBe(0);
    await maintenanceProcessor({ name: "thread-expire", data: { kind: "thread-expire" } } as never);
    const again = await threadGate.get(threadId);
    expect((again as any).status).toBe("expired");
  });

  it("routes the data.kind fallback shape to the same handler", async () => {
    const { threadId } = await seedChannelWithExpiredThread();
    // job.name does not match; only data.kind identifies the job (BullMQ v6
    // upsertJobScheduler shape parity with the name-first dispatch).
    await maintenanceProcessor({ name: "unrecognized", data: { kind: "thread-expire" } } as never);
    const after = await threadGate.get(threadId);
    expect((after as any).status).toBe("expired");
  });
});
