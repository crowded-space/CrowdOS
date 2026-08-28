import { createHash } from "node:crypto";

export type ApprovalRiskClass =
  | "install"
  | "network"
  | "destructive"
  | "git_push"
  | "db_write"
  | "general";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  argsPreview: Record<string, unknown> | null;
  riskClass: ApprovalRiskClass;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  expiresAt: Date | null;
  scope: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface CreateApprovalInput {
  runId: string;
  toolName: string;
  argsPreview?: Record<string, unknown> | null;
  riskClass: ApprovalRiskClass;
  requestedBy: string;
  expiresAt?: Date | null;
  scope?: string | null;
  status?: ApprovalStatus;
  decidedBy?: string | null;
}

export interface DecideApprovalInput {
  decision: "approved" | "denied";
  decidedBy: string;
  scope?: string | null;
  expiresAt?: Date | null;
}

export const APPROVAL_PENDING_TTL_MS = (() => {
  const raw = process.env.APPROVAL_TTL_MS ?? process.env.APPROVAL_PENDING_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 5 * 60 * 1000; // 5 minutes default
})();

export const APPROVAL_REUSABLE_TTL_MS = (() => {
  const raw = process.env.APPROVAL_REUSABLE_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 60 * 60 * 1000; // 1 hour default for reusable grants
})();

export function isApprovalsEnabled(): boolean {
  return process.env.APPROVALS_ENABLED === "true";
}

export function computeScopeHash(toolName: string, argsPreview: Record<string, unknown> | null | undefined): string {
  const payload = JSON.stringify({ tool: toolName, args: argsPreview ?? null });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function mapVerdictToRiskClass(reason: string, toolName?: string): ApprovalRiskClass {
  const lower = (reason || "").toLowerCase();
  const toolLower = (toolName || "").toLowerCase();

  // tool-specific fallback
  if (toolLower === "query_database") return "db_write";
  if (toolLower === "write_file" || toolLower === "delete_file" || toolLower === "edit_file") return "destructive";

  if (lower.includes("package installation") || lower.includes("package manager lifecycle") || lower.includes("package runner")) {
    return "install";
  }
  if (lower.includes("network fetch") || lower.includes("remote access") || lower.includes("container operation") || lower.includes("network listener")) {
    return "network";
  }
  if (lower.includes("git remote operation") || lower.includes("git push") || lower.includes("git pull")) {
    return "git_push";
  }
  if (lower.includes("database drop") || lower.includes("database truncate") || lower.includes("database") || lower.includes("db_write")) {
    return "db_write";
  }
  if (
    lower.includes("recursive delete") ||
    lower.includes("filesystem destructive") ||
    lower.includes("system shutdown") ||
    lower.includes("disk format") ||
    lower.includes("recursive windows delete") ||
    lower.includes("recursive permission change") ||
    lower.includes("overly permissive chmod") ||
    lower.includes("persistence mechanism") ||
    lower.includes("audit/history tampering") ||
    lower.includes("destructive")
  ) {
    return "destructive";
  }
  // interpreters/shell inline could be destructive or general; default to general unless matched above
  return "general";
}

export function argsPreviewFromCommand(toolName: string, args: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!args) return null;
  // truncate long strings for preview
  const preview: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      preview[k] = v.length > 500 ? v.slice(0, 500) + "…[truncated]" : v;
    } else if (v && typeof v === "object") {
      try {
        const s = JSON.stringify(v);
        preview[k] = s.length > 500 ? s.slice(0, 500) + "…[truncated]" : v;
      } catch {
        preview[k] = String(v).slice(0, 500);
      }
    } else {
      preview[k] = v;
    }
  }
  return preview;
}
