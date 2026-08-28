import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, desc } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { approvalRequests } from "../db/schema.js";
import type { ApprovalRiskClass, ApprovalStatus, CreateApprovalInput, DecideApprovalInput } from "./approvalTypes.js";
import { APPROVAL_PENDING_TTL_MS, APPROVAL_REUSABLE_TTL_MS } from "./approvalTypes.js";

export type ApprovalRow = typeof approvalRequests.$inferSelect;

function toApprovalStatus(s: string): ApprovalStatus {
  return s as ApprovalStatus;
}

export async function createRequest(input: CreateApprovalInput): Promise<ApprovalRow> {
  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const expiresAt =
    input.expiresAt !== undefined
      ? input.expiresAt
      : input.status === "approved"
        ? new Date(now.getTime() + APPROVAL_REUSABLE_TTL_MS)
        : new Date(now.getTime() + APPROVAL_PENDING_TTL_MS);
  const [row] = await db
    .insert(approvalRequests)
    .values({
      id,
      runId: input.runId,
      toolName: input.toolName,
      argsPreview: input.argsPreview ?? null,
      riskClass: input.riskClass as ApprovalRiskClass,
      status: (input.status ?? "pending") as ApprovalStatus,
      requestedBy: input.requestedBy,
      decidedBy: input.decidedBy ?? null,
      expiresAt: expiresAt as Date | null,
      scope: input.scope ?? null,
      decidedAt: input.status === "approved" || input.status === "denied" ? now : null,
    })
    .returning();
  return row;
}

export async function createPendingRequest(input: Omit<CreateApprovalInput, "status"> & { expiresAt?: Date | null }): Promise<ApprovalRow> {
  return createRequest({ ...input, status: "pending" });
}

export async function createApprovedRequest(input: CreateApprovalInput & { decidedBy: string; expiresAt?: Date | null }): Promise<ApprovalRow> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + APPROVAL_REUSABLE_TTL_MS);
  return createRequest({ ...input, status: "approved", expiresAt, decidedBy: input.decidedBy });
}

export async function getById(id: string): Promise<ApprovalRow | null> {
  const db = getDb();
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  return row ?? null;
}

export async function findPendingByRun(runId: string): Promise<ApprovalRow[]> {
  const db = getDb();
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.runId, runId), eq(approvalRequests.status, "pending")));
}

export async function listByRun(runId: string): Promise<ApprovalRow[]> {
  const db = getDb();
  return db.select().from(approvalRequests).where(eq(approvalRequests.runId, runId)).orderBy(desc(approvalRequests.createdAt));
}

export async function findReusableGrant(
  toolName: string,
  scopeHash: string,
  requestedBy: string
): Promise<ApprovalRow | null> {
  const db = getDb();
  const now = new Date();
  // Reusable grant: approved, same tool, same scope hash, same requester, not expired
  // Also consider scope matching if scope is null? Must match hash.
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.toolName, toolName),
        eq(approvalRequests.scope, scopeHash),
        eq(approvalRequests.status, "approved"),
        eq(approvalRequests.requestedBy, requestedBy),
        gt(approvalRequests.expiresAt, now)
      )
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(1);
  if (rows.length > 0) return rows[0];
  // Fallback: allow global reusable grant ignoring requestedBy (per some spec interpretations)
  // But prefer per-requester isolation; only fallback if strict not found.
  // Check without requestedBy constraint but same scope/tool and not expired
  const fallback = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.toolName, toolName),
        eq(approvalRequests.scope, scopeHash),
        eq(approvalRequests.status, "approved"),
        gt(approvalRequests.expiresAt, now)
      )
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(1);
  return fallback[0] ?? null;
}

export async function decide(id: string, input: DecideApprovalInput): Promise<ApprovalRow | null> {
  const db = getDb();
  const [current] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  if (!current) return null;
  if (current.status !== "pending") return null;

  const now = new Date();
  let expiresAt: Date | null = current.expiresAt;
  let scope = current.scope;

  // If decision is approved and scope indicates reusable, extend expiry
  // input.scope can be "reusable", a duration string, or explicit hash override
  if (input.decision === "approved") {
    if (input.scope) {
      // If custom scope provided, use it; otherwise keep existing hash
      // If scope === "reusable", keep hash but extend TTL
      if (input.scope !== "reusable") {
        scope = input.scope;
      }
      // Extend expiry for reusable grants
      expiresAt = input.expiresAt ?? new Date(now.getTime() + APPROVAL_REUSABLE_TTL_MS);
    } else if (input.expiresAt) {
      expiresAt = input.expiresAt;
    } else {
      // For one-shot approvals, keep short TTL or set to reusable TTL?
      // Keep pending's expiry or extend to reusable if scope exists
      if (scope) {
        expiresAt = new Date(now.getTime() + APPROVAL_REUSABLE_TTL_MS);
      }
    }
  }

  const [updated] = await db
    .update(approvalRequests)
    .set({
      status: input.decision as ApprovalStatus,
      decidedBy: input.decidedBy,
      decidedAt: now,
      scope,
      expiresAt,
    })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending")))
    .returning();

  return updated ?? null;
}

export async function expirePendingApprovals(): Promise<ApprovalRow[]> {
  const db = getDb();
  const now = new Date();
  const pending = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.status, "pending"), lt(approvalRequests.expiresAt, now)));

  const expired: ApprovalRow[] = [];
  for (const row of pending) {
    const [updated] = await db
      .update(approvalRequests)
      .set({ status: "expired" as ApprovalStatus, decidedAt: now })
      .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "pending")))
      .returning();
    if (updated) expired.push(updated);
  }
  return expired;
}

export async function sweepExpired(): Promise<number> {
  const rows = await expirePendingApprovals();
  return rows.length;
}

export async function findPending(approvalId: string): Promise<ApprovalRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.status, "pending")))
    .limit(1);
  return row ?? null;
}
