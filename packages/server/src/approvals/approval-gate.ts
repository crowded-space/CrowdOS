import {
  createRequest,
  createPendingRequest,
  createApprovedRequest,
  getById,
  findPendingByRun,
  listByRun,
  findReusableGrant,
  decide,
  expirePendingApprovals,
  sweepExpired,
  findPending,
} from "./approval-repository.js";
import type { ApprovalRow } from "./approval-repository.js";
import type {
  ApprovalRequest,
  ApprovalRiskClass,
  ApprovalStatus,
  CreateApprovalInput,
  DecideApprovalInput,
} from "./approval-types.js";
import {
  isApprovalsEnabled,
  computeScopeHash,
  mapVerdictToRiskClass,
  argsPreviewFromCommand,
  APPROVAL_PENDING_TTL_MS,
  APPROVAL_REUSABLE_TTL_MS,
} from "./approval-types.js";

export type { ApprovalRow, ApprovalRequest, ApprovalRiskClass, ApprovalStatus, CreateApprovalInput, DecideApprovalInput };
export {
  isApprovalsEnabled,
  computeScopeHash,
  mapVerdictToRiskClass,
  argsPreviewFromCommand,
  APPROVAL_PENDING_TTL_MS,
  APPROVAL_REUSABLE_TTL_MS,
};

export const approvalGate = {
  create: createRequest,
  createPending: createPendingRequest,
  createApproved: createApprovedRequest,
  getById,
  findPending,
  findPendingByRun,
  listByRun,
  findReusableGrant,
  decide,
  expirePendingApprovals,
  sweepExpired,
  isEnabled: isApprovalsEnabled,
  computeScopeHash,
  mapRisk: mapVerdictToRiskClass,
  argsPreview: argsPreviewFromCommand,
};

export type ApprovalDecidedPayload = {
  runId: string;
  approvalId: string;
  tool: string;
  decision: "approved" | "denied" | "expired";
  decidedBy: string | null;
  scope?: string | null;
  riskClass?: string;
  channelId?: string;
  workspaceId?: string;
  autoApproved?: boolean;
};

// ponytail: single emit — sweeper + REST/socket + executor share one shape, warn-and-skip when unregistered.
export function emitDecided(
  broker: any,
  payload: ApprovalDecidedPayload,
): void {
  if (!broker || typeof broker.emit !== "function") {
    console.warn("[approvals] dropped approval.decided: no shared broker registered");
    return;
  }
  try {
    broker.emit(
      "approval.decided" as never,
      payload as never,
      payload.channelId ? ({ channelId: payload.channelId } as never) : (undefined as never),
    );
  } catch {}
}
