import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspaceUrls: new Map<string, string | null>(),
  workspaceResolutions: [] as string[],
  pgRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Simulate DATABASE_URL being unset while a tenant has its own URL.
    isDatabaseConfigured: () => false,
    dbForWorkspace: async (workspaceId: string) => {
      h.workspaceResolutions.push(workspaceId);
      return {
        query: {
          threads: {
            findMany: async () => h.pgRows,
          },
        },
      };
    },
  };
});

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    tierContextFor: async (workspaceId: string) => ({
      workspaceId,
      databaseUrl: h.workspaceUrls.get(workspaceId) ?? null,
    }),
  };
});

import { threadGate } from "./thread-gate.js";

describe("Threads workspace storage mode", () => {
  beforeEach(() => {
    h.workspaceUrls.clear();
    h.workspaceResolutions.length = 0;
    h.pgRows.length = 0;
  });

  it("uses a workspace database when only its keyed URL is configured", async () => {
    const row = {
      id: "thr_workspace_db",
      channelId: "channel_workspace_db",
      status: "active",
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    h.workspaceUrls.set("ws-workspace-db", "postgresql://tenant.example/crowdos");
    h.pgRows.push(row);

    const result = await threadGate.list(
      "channel_workspace_db",
      { includeArchived: true },
      { workspaceId: "ws-workspace-db" },
    );

    expect(result).toEqual([row]);
    expect(h.workspaceResolutions).toEqual(["ws-workspace-db"]);
  });
});
