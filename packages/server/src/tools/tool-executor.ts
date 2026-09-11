import { getDb } from "../shared/config/database.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Guard } from "./safety/guard.js";
import { toolRegistry } from "./tool-registry.js";
import { skillsGate } from "../skills/skills-gate.js";
import { timeAsync, recordTiming } from "../shared/core/perf-metrics.js";
import type { ToolResult, ToolExecutionContext, ToolEffectClass } from "./tool-types.js";
import { ToolTimeoutError } from "./tool-types.js";
import { approvalGate } from "../approvals/approval-gate.js";
import { runsGate } from "../runs/runs-gate.js";

/**
 * PERF-8 static read/write classifier. Registration metadata (ToolDefinition /
 * CrowdToolMetadata `effectClass`) wins; otherwise this name map applies;
 * unknown tools default conservatively to 'write' (serialized).
 */
const STATIC_TOOL_EFFECT_CLASSES: Record<string, ToolEffectClass> = {
  read_file: "read",
  list_directory: "read",
  web_search: "read",
  search_all_channels: "read",
  open_memory: "read",
  query_database: "read",
  write_file: "write",
  delete_file: "write",
  remember: "write",
  discard_memory_from_context: "write",
  lock_in: "write",
  lock_out: "write",
  execute_bash: "side-effect",
  execute_safe: "side-effect",
  dispatch_agent: "side-effect",
  system_scheduler: "side-effect",
};

export function classifyToolEffect(toolName: string, def?: { effectClass?: ToolEffectClass }): ToolEffectClass {
  if (def?.effectClass) return def.effectClass;
  return STATIC_TOOL_EFFECT_CLASSES[toolName] ?? "write";
}

export interface BatchedToolCall {
  toolId: string;
  args: Record<string, unknown>;
}

const DEFAULT_MAX_PARALLEL_READS = 4;

// Approval fallback poll (one DB getById per tick while a run waits, up to ~5min).
// Slow on purpose: the broker event is the fast path, this is only the fallback.
const APPROVAL_FALLBACK_POLL_INITIAL_MS = 1000;
const APPROVAL_FALLBACK_POLL_MAX_MS = 5000;

async function runBoundedPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class ToolExecutor {
  static async execute(
    agentId: string,
    toolId: string,
    args: any,
    partialCtx?: Partial<ToolExecutionContext>
  ): Promise<ToolResult> {
    const instance = new ToolExecutor();
    return timeAsync(`tool.execute:${toolId}`, () => instance.execute(agentId, toolId, args, partialCtx));
  }

  /**
   * PERF-8 batch scheduling. TOOL_RWP !== 'false': read-classified calls run
   * concurrently (bounded) while write/side-effect calls run sequentially in
   * their original relative order; the results array is always in request
   * order. TOOL_RWP === 'false': legacy all-or-nothing — a batch parallelizes
   * only when EVERY call is read-classified, otherwise fully serial.
   */
  static async executeBatch(
    agentId: string,
    calls: BatchedToolCall[],
    partialCtx?: Partial<ToolExecutionContext>
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    if (calls.length === 0) return results;

    const runOne = (index: number): Promise<ToolResult> =>
      ToolExecutor.execute(agentId, calls[index].toolId, calls[index].args, partialCtx);

    const classes = calls.map((c) => classifyToolEffect(c.toolId, toolRegistry.get(c.toolId)));

    if (process.env.TOOL_RWP === "false") {
      const legacyParallel = calls.length > 1 && classes.every((k) => k === "read");
      if (legacyParallel) {
        return Promise.all(calls.map((_, i) => runOne(i)));
      }
      for (let i = 0; i < calls.length; i++) {
        results[i] = await runOne(i);
      }
      return results;
    }

    const readIndexes: number[] = [];
    const serialIndexes: number[] = [];
    classes.forEach((k, i) => {
      if (k === "read") readIndexes.push(i);
      else serialIndexes.push(i);
    });

    const maxReadConcurrency =
      parsePositiveIntEnv(process.env.TOOL_RWP_MAX_READ_CONCURRENCY, DEFAULT_MAX_PARALLEL_READS);

    // Preserve program order for read-after-write: reads before first write can run in parallel,
    // reads after first write must run serially in original order to see prior writes.
    const firstSerial = serialIndexes.length > 0 ? Math.min(...serialIndexes) : Infinity;
    const earlyReads = readIndexes.filter((i) => i < firstSerial);
    const lateReads = new Set(readIndexes.filter((i) => i >= firstSerial));
    await runBoundedPool(earlyReads, maxReadConcurrency, async (i) => {
      results[i] = await runOne(i);
    });
    // Serial tail: interleave late reads and writes in original order
    const serialTail: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (serialIndexes.includes(i) || lateReads.has(i)) serialTail.push(i);
    }
    serialTail.sort((a, b) => a - b);
    for (const i of serialTail) {
      results[i] = await runOne(i);
    }
    return results;
  }

  async execute(
    agentId: string,
    toolId: string,
    args: any,
    partialCtx?: Partial<ToolExecutionContext>
  ): Promise<ToolResult> {
    const db = getDb();
    const startTime = Date.now();
    const __runId = (partialCtx as unknown as { runId?: string | null })?.runId ?? null;
    const __channelId = (partialCtx as unknown as { channelId?: string })?.channelId ?? "general";
    const __tracing: typeof import("../observability/tracing.js") | null = await import("../observability/tracing.js").catch(() => null);
    const __span = __tracing ? __tracing.startSpan("tool", { runId: __runId, channelId: __channelId, agentId, attributes: { tool: toolId } }) : null;

    try {
      // 1. Fetch Agent Identity
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });

      if (!agent) {
        throw new Error(`Agent not found with id: ${agentId}`);
      }

      // 2. Authorize Tool (Resolves direct grants + active skill tools + universal tools)
      const allowedTools = await skillsGate.getResolvedToolsForAgent(agentId);
      const isAllowed = allowedTools.includes(toolId) || 
        ["open_memory", "discard_memory_from_context", "remember"].includes(toolId);

      if (!isAllowed) {
        throw new Error(`Security breach: Tool "${toolId}" is not authorized for @${agent.name}. Please grant it via ToolkitModule or attach a relevant Skill.`);
      }

      // 3. Retrieve tool definition from central registry
      const toolDef = toolRegistry.get(toolId);
      if (!toolDef) {
        throw new Error(`System Error: Tool "${toolId}" not found in central tool registry.`);
      }

      // 4. Enforce authLevelRequired
      if (toolDef.authLevelRequired !== undefined) {
        if (agent.authorityLevel > toolDef.authLevelRequired && !agent.isOmniscient) {
          throw new Error(`Security breach: Tool "${toolId}" requires Level ${toolDef.authLevelRequired} authority. @${agent.name} is Level ${agent.authorityLevel} (Non-Omniscient).`);
        }
      }

      // 5. Run Safety Guards — APR-1 tri-state: DENY always blocks, ASK blocks only
      // when APPROVALS_ENABLED=false (legacy). When enabled, ASK triggers the
      // Approvals domain pause flow (WAITING_FOR_APPROVAL → grant/deny).
      if (toolId === "execute_bash") {
        const verdict = Guard.evaluateCommand(args.command);
        if (verdict.decision === "DENY") {
          throw new Error(`Safety DENY: ${verdict.reason}. Command blocked: "${args.command.slice(0, 120)}"`);
        }
        if (verdict.decision === "ASK") {
          const approvalsEnabled = process.env.APPROVALS_ENABLED === "true";
          if (!approvalsEnabled) {
            throw new Error(
              `Safety ASK: ${verdict.reason}. Command requires approval (not yet granted): "${args.command.slice(0, 120)}"`
            );
          }
          // Approvals enabled — handle pause flow synchronously (not queued).
          const runId = (partialCtx as unknown as { runId?: string })?.runId ?? (partialCtx as unknown as { runId?: string | null })?.runId ?? null;
          const channelIdForEvent = (partialCtx as unknown as { channelId?: string })?.channelId || "general";
          const workspaceIdForEvent = (partialCtx as unknown as { workspaceId?: string })?.workspaceId || "default";
          const requestedBy = agentId;
          if (!runId) {
            throw new Error(
              `Safety ASK: ${verdict.reason}. Command requires approval but no run context: "${args.command.slice(0, 120)}"`
            );
          }
          const riskClass = approvalGate.mapRisk(verdict.reason, toolId);
          const argsPreview = approvalGate.argsPreview(toolId, args as Record<string, unknown>) ?? { command: String(args.command).slice(0, 500) };
          const scopeHash = approvalGate.computeScopeHash(toolId, argsPreview);

          // Reusable grant check — auto-approve without new pending row if a
          // still-valid grant exists for (tool, scopeHash, requester). Audit
          // still logs a new approved row.
          const reusable = await (approvalGate as any).findReusableGrant?.(toolId, scopeHash, requestedBy);
          if (reusable) {
            try {
              const autoRow = await approvalGate.createApproved({
                runId,
                toolName: toolId,
                argsPreview: argsPreview as Record<string, unknown>,
                riskClass,
                requestedBy,
                scope: scopeHash,
                decidedBy: reusable.decidedBy ?? requestedBy,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
              });
              // Emit audit events for the auto-approved path (fire-and-forget)
              try {
                const broker = (partialCtx as unknown as { broker?: unknown })?.broker as { emit?: (t: string, p: unknown, o?: unknown) => void } | undefined;
                const emitVia = broker ?? (await import("../shared/sockets/register-socket-server.js").then(m => (m as unknown as { globalBroker?: { emit: (t: string, p: unknown, o?: unknown) => void } }).globalBroker).catch(() => null));
                const payloadRequested = { runId, approvalId: autoRow.id, tool: toolId, argsPreview, riskClass, scope: scopeHash, autoApproved: true };
                const payloadDecided = { runId, approvalId: autoRow.id, tool: toolId, decision: "approved" as const, decidedBy: autoRow.decidedBy, scope: scopeHash, autoApproved: true };
                if (emitVia && typeof (emitVia as { emit?: unknown }).emit === "function") {
                  (emitVia as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("approval.requested" as never, payloadRequested as never, { channelId: channelIdForEvent } as never);
                  (emitVia as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("approval.decided" as never, payloadDecided as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../event-broker/event-broker-gate.js");
                  const eb = new EventBroker();
                  eb.emit("approval.requested" as never, payloadRequested as never, { channelId: channelIdForEvent } as never);
                  eb.emit("approval.decided" as never, payloadDecided as never, { channelId: channelIdForEvent } as never);
                }
              } catch {}
              // Fall through to handler execution — approval granted via reusable grant
            } catch (e) {
              // If audit row fails, still allow execution (grant was valid); log only
              console.warn(`[ToolExecutor] reusable grant audit failed for ${toolId}:`, (e as Error)?.message || e);
            }
          } else {
            // Create pending approval, pause run, emit, and block until decision
            const ttlRaw = process.env.APPROVAL_TTL_MS ?? process.env.APPROVAL_PENDING_TTL_MS;
            const ttlMs = ttlRaw ? Number(ttlRaw) : NaN;
            const pendingTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 60 * 1000;
            const expiresAt = new Date(Date.now() + pendingTtl);
            let pendingRow: Awaited<ReturnType<typeof approvalGate.createPending>>;
            try {
              pendingRow = await approvalGate.createPending({
                runId,
                toolName: toolId,
                argsPreview: argsPreview as Record<string, unknown>,
                riskClass,
                requestedBy,
                scope: scopeHash,
                expiresAt,
              });
            } catch (e) {
              throw new Error(`Failed to create approval request: ${(e as Error)?.message || String(e)}`);
            }

            // Transition run WAITING_FOR_APPROVAL (RUN-1 state machine)
            try {
              await runsGate.transition(runId, "waiting_for_approval", `approval_required:${toolId}:${riskClass}`);
            } catch {}

            // Emit approval.requested (room-scoped)
            try {
              const broker = (partialCtx as unknown as { broker?: unknown })?.broker as { emit?: (t: string, p: unknown, o?: unknown) => void } | undefined;
              const payload = { runId, approvalId: pendingRow.id, tool: toolId, argsPreview, riskClass, scope: scopeHash, requestedBy, expiresAt: expiresAt.toISOString(), workspaceId: workspaceIdForEvent };
              if (broker && typeof broker.emit === "function") {
                broker.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
              } else {
                const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
                const emitVia = globalBroker as unknown as { emit?: (t: string, p: unknown, o?: unknown) => void } | null;
                if (emitVia && typeof emitVia.emit === "function") {
                  emitVia.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../event-broker/event-broker-gate.js");
                  const eb = new EventBroker();
                  eb.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
                }
              }
            } catch (e) {
              console.warn("[ToolExecutor] approval.requested emit failed:", (e as Error)?.message || e);
            }

            // Hybrid event-driven + bounded-poll approval wait. Holds 1 run-worker
            // slot while waiting (suspend-and-resume would fix that but is a bigger
            // redesign — skipped); broker 'approval.decided' is the fast path, DB
            // fallback poll runs 1s→5s backoff so a 5min wait costs ~10² queries, not ~10³.
            const abortSignal = (partialCtx as unknown as { abortSignal?: AbortSignal })?.abortSignal;
            const startWait = Date.now();
            let decidedRow: Awaited<ReturnType<typeof approvalGate.getById>> = null;
            let approvalWaitPolls = 0;
            // P20: wait-timeout observability. The wait below holds a run-worker
            // slot while sleeping but NOT a PG conn (one short getById per tick);
            // record wait latency + poll count so slot exhaustion is visible in
            // perf-metrics. True suspend-and-resume (job.moveToDelayed + requeue)
            // would free the slot but needs the BullMQ Job handle threaded
            // through runtime → executor — bigger redesign, deliberately skipped.

            const waitForApprovalDecision = async (): Promise<typeof decidedRow> => {
              const pendingId = pendingRow.id;
              let settled = false;
              let off: (() => void) | null = null;
              let timer: ReturnType<typeof setTimeout> | null = null;
              let pollBackoff = APPROVAL_FALLBACK_POLL_INITIAL_MS;

              const cleanup = () => {
                settled = true;
                if (off) try { off(); } catch {}
                if (timer) clearTimeout(timer);
              };

              return new Promise<typeof decidedRow>((resolve, reject) => {
                if (abortSignal?.aborted) {
                  resolve(null);
                  return;
                }
                const onAbort = () => {
                  cleanup();
                  resolve(null);
                };
                abortSignal?.addEventListener('abort', onAbort, { once: true });

                // Primary: broker event for this approvalId
                const tryAttachBroker = async () => {
                  try {
                    const brokerEvt = (partialCtx as unknown as { broker?: { on?: (t: string, cb: (p: any) => void) => string | void; off?: (t: string, id: string | (() => void)) => void } })?.broker as any;
                    const globalMod = brokerEvt?.on ? null : await import("../shared/sockets/register-socket-server.js").then(m => (m as unknown as { globalBroker?: any }).globalBroker).catch(() => null);
                    const evtBroker = brokerEvt?.on ? brokerEvt : (globalMod as any);
                    // Try EventBroker instance fallback if no global
                    const ebFallback = !evtBroker?.on ? (await import("../event-broker/event-broker-gate.js").then(m => (m as any).EventBroker ? new (m as any).EventBroker() : null).catch(() => null)) : null;
                    const targetBroker = evtBroker?.on ? evtBroker : ebFallback;
                    if (targetBroker && typeof targetBroker.on === 'function') {
                      const handler = (payload: any) => {
                        const pid = payload?.approvalId || payload?.id;
                        if (pid !== pendingId) return;
                        if (settled) return;
                        cleanup();
                        abortSignal?.removeEventListener('abort', onAbort);
                        // Fast path: fetch decided row once
                        approvalGate.getById(pendingId).then(r => resolve(r)).catch(() => resolve(null));
                      };
                      try {
                        const subId = targetBroker.on('approval.decided', undefined, handler as any);
                        off = () => {
                          try {
                            if (typeof targetBroker.off === 'function') {
                              if (typeof subId === 'string') targetBroker.off(subId);
                            }
                          } catch {}
                        };
                      } catch {
                        // fallback to poll only
                      }
                    }
                  } catch {}
                };
                void tryAttachBroker();

                // Fallback: exponential poll (starts 400ms, doubles to max 2000ms)
                const poll = async () => {
                  if (settled) return;
                  if (abortSignal?.aborted) {
                    cleanup();
                    resolve(null);
                    return;
                  }
                  if (Date.now() - startWait > pendingTtl + 2000) {
                    try { await approvalGate.expirePendingApprovals(); } catch {}
                    const after = await approvalGate.getById(pendingId).catch(() => null);
                    cleanup();
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(after);
                    return;
                  }
                  const current = await approvalGate.getById(pendingId).catch(() => null);
                  approvalWaitPolls += 1;
                  if (!current) {
                    cleanup();
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(null);
                    return;
                  }
                  if (current.status === 'approved' || current.status === 'denied' || current.status === 'expired') {
                    cleanup();
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(current);
                    return;
                  }
                  if (current.expiresAt && Date.now() >= new Date(current.expiresAt).getTime()) {
                    try { await approvalGate.expirePendingApprovals(); } catch {}
                    const after2 = await approvalGate.getById(pendingId).catch(() => current);
                    cleanup();
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(after2 ?? ({ ...current, status: 'expired' as const } as typeof current));
                    return;
                  }
                  timer = setTimeout(poll, pollBackoff);
                  pollBackoff = Math.min(APPROVAL_FALLBACK_POLL_MAX_MS, Math.round(pollBackoff * 1.6));
                };
                // Kick first poll quickly then backoff
                timer = setTimeout(poll, APPROVAL_FALLBACK_POLL_INITIAL_MS);
                // Also hard TTL guard
                setTimeout(() => {
                  if (settled) return;
                  poll();
                }, pendingTtl + 2500).unref?.();
              });
            };

            const awaited = await waitForApprovalDecision();
            try {
              recordTiming("approval.wait_ms", Date.now() - startWait);
              recordTiming("approval.wait_polls", approvalWaitPolls);
            } catch {}
            if (abortSignal?.aborted || awaited === null) {
              // Distinguish abort vs disappeared
              const check = awaited === null && abortSignal?.aborted ? 'approval_cancelled' : 'approval_not_found';
              try { await runsGate.transition(runId, "running", check); } catch {}
              if (abortSignal?.aborted) throw new Error(`Tool "${toolId}" approval wait cancelled by user.`);
              throw new Error(`Approval ${pendingRow.id} disappeared — denying command.`);
            }
            decidedRow = awaited;

            // Emit approval.decided for observers (both grant and deny paths)
            try {
              const decidedStatus = decidedRow!.status;
              const decidedPayload = {
                runId,
                approvalId: pendingRow.id,
                tool: toolId,
                decision: decidedStatus === "approved" ? "approved" as const : decidedStatus === "denied" ? "denied" as const : "expired" as const,
                decidedBy: (decidedRow as unknown as { decidedBy?: string | null })?.decidedBy ?? null,
                scope: scopeHash,
                riskClass,
              };
              const broker = (partialCtx as unknown as { broker?: unknown })?.broker as { emit?: (t: string, p: unknown, o?: unknown) => void } | undefined;
              if (broker && typeof broker.emit === "function") {
                broker.emit("approval.decided" as never, decidedPayload as never, { channelId: channelIdForEvent } as never);
              } else {
                const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
                const emitVia = globalBroker as unknown as { emit?: (t: string, p: unknown, o?: unknown) => void } | null;
                if (emitVia && typeof emitVia.emit === "function") {
                  emitVia.emit("approval.decided" as never, decidedPayload as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../event-broker/event-broker-gate.js");
                  const eb = new EventBroker();
                  eb.emit("approval.decided" as never, decidedPayload as never, { channelId: channelIdForEvent } as never);
                }
              }
            } catch {}

            if (decidedRow!.status === "approved") {
              // Resume run RUNNING and fall through to handler execution
              try { await runsGate.transition(runId, "running", "approval_granted"); } catch {}
            } else {
              // DENY / EXPIRED: resume RUNNING but fail the tool safely; run continues per APR-1 policy (documented)
              try { await runsGate.transition(runId, "running", `approval_${decidedRow!.status}`); } catch {}
              const reasonMap: Record<string, string> = {
                denied: `approval denied by operator`,
                expired: `approval expired (TTL default-deny)`,
              };
              const why = reasonMap[decidedRow!.status] ?? `approval ${decidedRow!.status}`;
              throw new Error(`Safety ASK denied: ${verdict.reason}. ${why} — command "${args.command.slice(0, 120)}" not executed (run ${runId} resumed, tool failed safely)`);
            }
          }
        }
      } else if (toolId === "execute_safe") {
        if (!Guard.isCommandWhitelisted(args.command)) {
          throw new Error(`Safety Alert: Command "${args.command}" is not in the system safe whitelist.`);
        }
      } else if (["write_file", "delete_file", "edit_file"].includes(toolId)) {
        // FS safety gate — check per-channel/workspace policy, then run approval flow if required
        const requiresApprovalFor = await (async () => {
          try {
            const chId = (partialCtx as unknown as { channelId?: string })?.channelId;
            const wsId = (partialCtx as unknown as { workspaceId?: string })?.workspaceId;
            // Load channel/workspace safety settings (fallback defaults)
            let policy: string[] = ["delete", "execute"]; // default per schema
            if (chId) {
              try {
                const { getDb } = await import("../shared/config/database.js");
                const { channelSettings, workspaceSafetySettings } = await import("../db/schema.js");
                const { eq } = await import("drizzle-orm");
                const db = getDb();
                const chRow = await db.query.channelSettings.findFirst({ where: eq(channelSettings.channelId, chId) });
                if ((chRow?.fsPolicy as any)?.requireApprovalFor) policy = (chRow!.fsPolicy as any).requireApprovalFor;
                else if (wsId) {
                  const wsRow = await db.query.workspaceSafetySettings.findFirst({ where: eq(workspaceSafetySettings.workspaceId, wsId) });
                  if ((wsRow?.fsPolicy as any)?.requireApprovalFor) policy = (wsRow!.fsPolicy as any).requireApprovalFor;
                }
              } catch {}
            }
            return policy;
          } catch { return ["delete", "execute"]; }
        })();
        const toolOp = toolId === "delete_file" ? "delete" : toolId === "write_file" || toolId === "edit_file" ? "write" : "general";
        const needsApproval = requiresApprovalFor.includes(toolOp as any);
        if (needsApproval) {
          // Check hierarchical grants first (channel > workspace > global)
          const approvalsEnabled = process.env.APPROVALS_ENABLED === "true";
          // Even if approvalsEnabled false, we still surface ASK as DENY for FS safety transparency
          const runId = (partialCtx as unknown as { runId?: string })?.runId ?? null;
          const channelIdForEvent = (partialCtx as unknown as { channelId?: string })?.channelId || "general";
          const workspaceIdForEvent = (partialCtx as unknown as { workspaceId?: string })?.workspaceId || "default";
          const requestedBy = agentId;
          const argsPreview = approvalGate.argsPreview(toolId, args as Record<string, unknown>) ?? { path: String((args as any).path ?? "").slice(0, 500) };
          const scopeHash = approvalGate.computeScopeHash(toolId, argsPreview);
          // Try grant lookup
          let hasGrant = false;
          try {
            const grant = await (approvalGate as any).findGrant?.(toolId, scopeHash, { workspaceId: workspaceIdForEvent, channelId: channelIdForEvent });
            if (grant) hasGrant = true;
            else {
              const reusable = await approvalGate.findReusableGrant(toolId, scopeHash, requestedBy);
              if (reusable) hasGrant = true;
            }
          } catch {}
          if (hasGrant) {
            // auto-allow via grant, continue to handler
          } else if (!approvalsEnabled) {
            throw new Error(`Safety ASK: FS ${toolOp} on "${(args as any).path}" requires approval for channel #${channelIdForEvent} (policy: ${requiresApprovalFor.join(",")})`);
          } else {
            if (!runId) throw new Error(`Safety ASK: FS ${toolOp} requires approval but no run context`);
            const riskClass = approvalGate.mapRisk(`destructive`, toolId);
            const ttlRaw = process.env.APPROVAL_TTL_MS ?? process.env.APPROVAL_PENDING_TTL_MS;
            const ttlMs = ttlRaw ? Number(ttlRaw) : NaN;
            const pendingTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 60 * 1000;
            const expiresAt = new Date(Date.now() + pendingTtl);
            const pendingRow = await approvalGate.createPending({
              runId,
              toolName: toolId,
              argsPreview: argsPreview as Record<string, unknown>,
              riskClass,
              requestedBy,
              scope: scopeHash,
              expiresAt,
            });
            try { await runsGate.transition(runId, "waiting_for_approval", `approval_required:${toolId}:${riskClass}`); } catch {}
            // Emit approval.requested
            try {
              const broker = (partialCtx as unknown as { broker?: unknown })?.broker as { emit?: (t: string, p: unknown, o?: unknown) => void } | undefined;
              const payload = { runId, approvalId: pendingRow.id, tool: toolId, argsPreview, riskClass, scope: scopeHash, requestedBy, expiresAt: expiresAt.toISOString(), workspaceId: workspaceIdForEvent };
              if (broker && typeof broker.emit === "function") broker.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
              else {
                const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
                const emitVia = globalBroker as unknown as { emit?: (t: string, p: unknown, o?: unknown) => void } | null;
                if (emitVia && typeof emitVia.emit === "function") emitVia.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
              }
            } catch {}
            // Reuse same hybrid wait as bash path — poll for decision
            const abortSignal = (partialCtx as unknown as { abortSignal?: AbortSignal })?.abortSignal;
            const startWait = Date.now();
            let decidedRow: any = null;
            const waitForFsApproval = async () => {
              return new Promise<any>((resolve) => {
                let timer: any = null;
                let pollBackoff = APPROVAL_FALLBACK_POLL_INITIAL_MS;
                let settled = false;
                const cleanup = () => { settled = true; if (timer) clearTimeout(timer); };
                const poll = async () => {
                  if (settled || abortSignal?.aborted) { cleanup(); resolve(null); return; }
                  if (Date.now() - startWait > pendingTtl + 2000) {
                    try { await approvalGate.expirePendingApprovals(); } catch {}
                    const after = await approvalGate.getById(pendingRow.id).catch(() => null);
                    cleanup(); resolve(after); return;
                  }
                  const current = await approvalGate.getById(pendingRow.id).catch(() => null);
                  if (!current) { cleanup(); resolve(null); return; }
                  if (current.status === "approved" || current.status === "denied" || current.status === "expired") { cleanup(); resolve(current); return; }
                  timer = setTimeout(poll, pollBackoff);
                  pollBackoff = Math.min(APPROVAL_FALLBACK_POLL_MAX_MS, Math.round(pollBackoff * 1.6));
                };
                timer = setTimeout(poll, APPROVAL_FALLBACK_POLL_INITIAL_MS);
                setTimeout(() => { if (settled) return; poll(); }, pendingTtl + 2500).unref?.();
              });
            };
            decidedRow = await waitForFsApproval();
            if (abortSignal?.aborted || !decidedRow) {
              try { await runsGate.transition(runId, "running", abortSignal?.aborted ? "approval_cancelled" : "approval_not_found"); } catch {}
              throw new Error(decidedRow === null && abortSignal?.aborted ? `Tool "${toolId}" approval wait cancelled by user.` : `Approval ${pendingRow.id} disappeared — denying FS operation.`);
            }
            try {
              const broker2 = (partialCtx as unknown as { broker?: any })?.broker;
              const emitVia2 = broker2 ?? (await import("../shared/sockets/register-socket-server.js").then(m => (m as any).globalBroker).catch(() => null));
              const payloadDecided = { runId, approvalId: pendingRow.id, tool: toolId, decision: decidedRow.status === "approved" ? "approved" as const : decidedRow.status === "denied" ? "denied" as const : "expired" as const, decidedBy: (decidedRow as any)?.decidedBy ?? null, scope: scopeHash, riskClass };
              if (emitVia2 && typeof emitVia2.emit === "function") emitVia2.emit("approval.decided" as never, payloadDecided as never, { channelId: channelIdForEvent } as never);
            } catch {}
            if (decidedRow.status === "approved") {
              try { await runsGate.transition(runId, "running", "approval_granted"); } catch {}
            } else {
              try { await runsGate.transition(runId, "running", `approval_${decidedRow.status}`); } catch {}
              const why = decidedRow.status === "denied" ? "approval denied by operator" : `approval ${decidedRow.status}`;
              throw new Error(`Safety ASK denied: FS ${toolOp} on "${(args as any).path}" — ${why} (run ${runId} resumed, tool failed safely)`);
            }
          }
        }
      }

      // 6. Build execution context
      const ctx: ToolExecutionContext = {
        agentId,
        channelId: partialCtx?.channelId || "general",
        workspaceId: partialCtx?.workspaceId || "default",
        authorityLevel: agent.authorityLevel,
        abortSignal: partialCtx?.abortSignal,
        logger: partialCtx?.logger || {
          info: (msg, meta) => console.log(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
          warn: (msg, meta) => console.warn(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
          error: (msg, meta) => console.error(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
        },
      };

      // 7. Execute Tool Handler with Timeout + Abort guard (P0-5, P1-8)
      const timeoutMs = toolDef.timeoutMs || 30000;
      console.log(`[ToolExecutor] [${agent.name}] Calling tool "${toolId}"...`);

      // Combine caller abortSignal with internal timeout signal — timeout now actually aborts underlying work (not just Promise.race leak)
      const abortController = new AbortController();
      const timeoutSignal = abortController.signal;

      // Propagate caller abort to internal controller
      if (partialCtx?.abortSignal) {
        if (partialCtx.abortSignal.aborted) abortController.abort((partialCtx.abortSignal as any).reason);
        else partialCtx.abortSignal.addEventListener("abort", () => abortController.abort((partialCtx.abortSignal as any).reason), { once: true });
      }

      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new ToolTimeoutError(
            `Tool "${toolId}" execution timed out after ${timeoutMs}ms.`
          );
          abortController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);

        timeoutSignal.addEventListener("abort", () => {
          if (timeoutId) clearTimeout(timeoutId);
          // Only reject if not already settled and abort reason is caller-initiated before timeout
          const reason = (timeoutSignal as any).reason as Error | undefined;
          if (reason && !(reason instanceof ToolTimeoutError)) {
            reject(new Error(`Tool "${toolId}" execution aborted by caller.`));
          }
        }, { once: true });
      });

      // Guard against unhandled rejection if execution wins the race
      timeoutPromise.catch(() => {});

      // Give handler the combined abortSignal so shell/process/fetch can actually stop (per TO_DO.md Phase 3)
      const executionCtx: ToolExecutionContext = { ...ctx, abortSignal: timeoutSignal };

      const executionPromise = toolDef.handler(args, executionCtx);

      // Swallow-and-log the race loser so timed-out work never surfaces as an orphaned rejection;
      // the loser has already been aborted via abortController above.
      executionPromise.catch((err) => {
        console.warn(`[ToolExecutor] [${agent.name}] Tool "${toolId}" settled after race (ignored):`, err?.message || err);
      });

      let result: ToolResult;
      try {
        result = await Promise.race([executionPromise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;

      console.log(`[ToolExecutor] [${agent.name}] Tool "${toolId}" finished in ${durationMs}ms (success: ${result.success})`);
      if (__span && __tracing) __tracing.endSpan(__span, { attributes: { durationMs, success: result.success } });
      return result;

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.warn(`[ToolExecutor] Security Blocked / Execution failed for tool "${toolId}" in ${durationMs}ms: ${err.message || err}`);
      if (__span && __tracing) __tracing.endSpan(__span, { error: err, attributes: { durationMs, success: false } });
      return {
        success: false,
        output: "",
        error: err.message || String(err),
        durationMs,
      };
    }
  }
}
