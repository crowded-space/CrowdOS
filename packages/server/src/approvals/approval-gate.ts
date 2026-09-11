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
