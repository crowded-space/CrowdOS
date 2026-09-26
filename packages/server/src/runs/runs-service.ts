import { createHash } from "node:crypto";
import {
  getRunById,
  applyTransition,
  getCompensation,
  deleteCompensation,
  listCompensations,
  type RunRow,
  type CompensationRow,
} from "./runs-repository.js";
import type { RunCheckpoint, CompensationInverseOp } from "../db/schema.js";

export async function resumeRun(runId: string, workspaceId?: string | null): Promise<{ run: RunRow; checkpoint: RunCheckpoint | null } | null> {
  const current = await getRunById(runId, workspaceId);
  if (!current) return null;
  if (current.status !== "resumable") return null;
  const result = await applyTransition(runId, "queued", { reason: "resume_requested", workspaceId });
  if (!result || !result.changed) return null;
  try {
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = getSharedBroker();
    if (broker) {
      broker.emit("run.status_changed", {
        runId: result.row.id,
        agentId: result.row.agentId,
        channelId: result.row.channelId,
        workspaceId: result.row.workspaceId,
        runtimeType: result.row.runtimeType,
        status: result.to,
        from: result.from,
        reason: result.reason,
        errorCode: result.row.errorCode,
      } as never, { channelId: result.row.channelId } as never);
    } else {
      console.warn("[Runs] dropped run.status_changed: no shared broker registered");
    }
  } catch {}
  const checkpoint = (result.row.checkpoint as RunCheckpoint | null) ?? (current.checkpoint as RunCheckpoint | null) ?? null;
  return { run: result.row, checkpoint };
}

export async function undoCompensation(
  runId: string,
  compId: string,
  workspaceId?: string | null
): Promise<{ ok: boolean; error?: string; entries?: CompensationRow[] }> {
  const row = await getCompensation(runId, compId, workspaceId);
  if (!row) return { ok: false, error: "compensation not found" };
  const inverse = row.inverseOp as CompensationInverseOp & { truncated?: boolean };
  // Validate the stored inverse before touching the filesystem: an unknown op
  // or a store-time-truncated >20k prefix must never be applied, and its
  // journal row stays for the operator to inspect.
  if (inverse.op !== "delete" && inverse.op !== "restore") {
    return { ok: false, error: `unknown compensation inverse op: ${String(inverse.op)}` };
  }
  if (inverse.op === "restore") {
    if (inverse.truncated) {
      return { ok: false, error: "compensation prior content truncated at store time; refusing partial restore" };
    }
    if (inverse.priorHash) {
      const actual = createHash("sha256").update(inverse.priorContentRef ?? "", "utf8").digest("hex");
      if (actual !== inverse.priorHash) {
        return { ok: false, error: "compensation prior hash mismatch (stored content corrupted)" };
      }
    }
  }
  try {
    let workspaceRoot: string | null = null;
    // Channel-mount-aware root: Zone B mount when one resolves, else Zone A
    // workspace-local. Same resolver the Repo panel and file tools use.
    try {
      const run = await getRunById(runId, workspaceId);
      const { channelMountGate } = await import("../channel-mounts/channel-mount-gate.js");
      const root = await channelMountGate.effectiveRoot({
        channelId: run?.channelId ?? null,
        workspaceId: run?.workspaceId ?? "default",
      });
      workspaceRoot = root.path;
    } catch {}
    if (!workspaceRoot) {
      // No resolvable root is a configuration error, not a licence to write
      // into the server's own tree. Fail loudly.
      return { ok: false, error: "no resolvable workspace root for compensation undo" };
    }
    const { Guard } = await import("../tools/tools-gate.js");
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    if (inverse.op === "delete") {
      const resolved = await Guard.validatePath(inverse.path, workspaceRoot);
      try { await fs.unlink(resolved); } catch (e: unknown) { const code = (e as { code?: string })?.code; if (code !== "ENOENT") throw e; }
    } else {
      const resolved = await Guard.validatePath(inverse.path, workspaceRoot);
      await fs.mkdir(pathMod.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, inverse.priorContentRef ?? "", "utf8");
    }
    await deleteCompensation(compId, workspaceId);
    // Single-emit owner is the route/socket caller: return entries for it to emit.
    try {
      const entries = await listCompensations(runId, workspaceId);
      return { ok: true, entries };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
