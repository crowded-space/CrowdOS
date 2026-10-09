// AP-005 regression guard (fix-approvals-micro-005-009).
//
// AP-005: the legacy scope:'reusable' sentinel tied the reusable-TTL expiry
// extension to the sentinel's presence even when scope assignment was skipped,
// so a session grant silently lived 1h and stayed matchable. The explicit
// `reuse` flag (AP-001) now owns that decision; this test pins the boundary:
// reuse:true → reusable TTL, reuse:false with a real scope → NO silent TTL
// extension, legacy sentinel still maps for compat.
//
// Hermetic: the DB boundary is mocked, so this runs without DATABASE_URL or a
// live PG (the pre-existing integration files remain DB-gated).
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = {
    id: string;
    runId: string;
    toolName: string;
    status: string;
    scope: string | null;
    expiresAt: Date | null;
    decidedBy: string | null;
    decidedAt: Date | null;
  };
  const rows = new Map<string, Row>();
  return { rows, currentClaimId: null as string | null };
});

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  }),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    // Minimal tx: update().set().where().returning() against the row map.
    const tx = {
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const id = h.currentClaimId;
              const row = id ? h.rows.get(id) : undefined;
              if (!row) return [];
              Object.assign(row, patch);
              return [{ ...row }];
            },
          }),
        }),
      }),
    };
    return fn(tx);
  },
  runWithDb: (_db: unknown, fn: () => unknown) => fn(),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the decide test mock");
  },
  isDatabaseConfigured: () => true,
  isNoDatabaseError: () => false,
  isConnectionError: () => false,
  noteDbFailure: () => {},
  noteDbSuccess: () => {},
  resolveTier: () => ({ tier: "local", url: null }),
  dbScopeKey: () => "global",
  closeDatabaseConnection: async () => {},
}));

import { decide } from "./approval-repository.js";
import { APPROVAL_REUSABLE_TTL_MS } from "./approval-types.js";

function seedPendingRow(id: string, scope: string | null, expiresAt: Date | null = null): void {
  h.rows.set(id, {
    id,
    runId: `run-${id}`,
    toolName: "execute_bash",
    status: "pending",
    scope,
    expiresAt,
    decidedBy: null,
    decidedAt: null,
  });
  h.currentClaimId = id;
}

afterEach(() => {
  h.rows.clear();
});

describe("AP-005 explicit reuse mode owns the reusable-TTL extension", () => {
  it("reuse:true grants the reusable TTL", async () => {
    seedPendingRow("ap005-reuse", "scope-hash-a");
    const before = Date.now();
    const row = await decide("ap005-reuse", { decision: "approved", decidedBy: "op", reuse: true });
    expect(row?.status).toBe("approved");
    expect(row?.scope).toBe("scope-hash-a");
    expect(row?.expiresAt).not.toBeNull();
    const delta = new Date(row!.expiresAt!).getTime() - before;
    expect(delta).toBeGreaterThan(APPROVAL_REUSABLE_TTL_MS - 5000);
    expect(delta).toBeLessThan(APPROVAL_REUSABLE_TTL_MS + 5000);
  });

  it("legacy scope:'reusable' still maps to reuse (compat)", async () => {
    seedPendingRow("ap005-legacy", "scope-hash-b");
    const row = await decide("ap005-legacy", { decision: "approved", decidedBy: "op", scope: "reusable" });
    expect(row?.status).toBe("approved");
    // Sentinel never becomes the stored scope; the row's real hash is kept.
    expect(row?.scope).toBe("scope-hash-b");
    expect(row?.expiresAt).not.toBeNull();
  });

  it("plain approval of a scoped row clears expiry — never reusable, no silent 1h extension (AP-005 boundary)", async () => {
    const pendingExpiry = new Date(Date.now() + 5 * 60 * 1000);
    seedPendingRow("ap005-plain", "scope-hash-c", pendingExpiry);
    const row = await decide("ap005-plain", { decision: "approved", decidedBy: "op" });
    expect(row?.status).toBe("approved");
    expect(row?.scope).toBe("scope-hash-c");
    // One-off grant: expiry cleared, so findReusableGrant (expiresAt > now)
    // can never match the row and the identical next call re-asks.
    expect(row?.expiresAt).toBeNull();
  });
});
