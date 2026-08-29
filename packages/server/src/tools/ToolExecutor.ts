import { getDb } from "../Shared/config/database.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Guard } from "./safety/Guard.js";
import { toolRegistry } from "./toolRegistry.js";
import { skillsGate } from "../Skills/skillsGate.js";
import { timeAsync } from "../Shared/core/perfMetrics.js";
import type { ToolResult, ToolExecutionContext, ToolEffectClass } from "./toolTypes.js";
import { ToolTimeoutError } from "./toolTypes.js";
import { approvalGate } from "../Approvals/approvalGate.js";
import { runsGate } from "../Runs/runsGate.js";

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
    const __tracing: typeof import("../Observability/tracing.js") | null = await import("../Observability/tracing.js").catch(() => null);
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
          const reusable = await approvalGate.findReusableGrant(toolId, scopeHash, requestedBy);
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
                const emitVia = broker ?? (await import("../Shared/sockets/registerSocketServer.js").then(m => (m as unknown as { globalBroker?: { emit: (t: string, p: unknown, o?: unknown) => void } }).globalBroker).catch(() => null));
                const payloadRequested = { runId, approvalId: autoRow.id, tool: toolId, argsPreview, riskClass, scope: scopeHash, autoApproved: true };
                const payloadDecided = { runId, approvalId: autoRow.id, tool: toolId, decision: "approved" as const, decidedBy: autoRow.decidedBy, scope: scopeHash, autoApproved: true };
                if (emitVia && typeof (emitVia as { emit?: unknown }).emit === "function") {
                  (emitVia as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("approval.requested" as never, payloadRequested as never, { channelId: channelIdForEvent } as never);
                  (emitVia as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("approval.decided" as never, payloadDecided as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
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
                const { globalBroker } = await import("../Shared/sockets/registerSocketServer.js");
                const emitVia = globalBroker as unknown as { emit?: (t: string, p: unknown, o?: unknown) => void } | null;
                if (emitVia && typeof emitVia.emit === "function") {
                  emitVia.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
                  const eb = new EventBroker();
                  eb.emit("approval.requested" as never, payload as never, { channelId: channelIdForEvent } as never);
                }
              }
            } catch (e) {
              console.warn("[ToolExecutor] approval.requested emit failed:", (e as Error)?.message || e);
            }

            // Hybrid event-driven + bounded-poll approval wait (was 300ms poll × ~1000 queries).
            // Listens for broker 'approval.decided' for this ID; falls back to exponential poll (max 2s)
            // so DB load is 2–3 queries vs 1000. Run-scoped cleanup ensures no listener leak.
            const abortSignal = (partialCtx as unknown as { abortSignal?: AbortSignal })?.abortSignal;
            const startWait = Date.now();
            let decidedRow: Awaited<ReturnType<typeof approvalGate.getById>> = null;

            const waitForApprovalDecision = async (): Promise<typeof decidedRow> => {
              const pendingId = pendingRow.id;
              let settled = false;
              let off: (() => void) | null = null;
              let timer: ReturnType<typeof setTimeout> | null = null;
              let pollBackoff = 400;

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
                    const globalMod = brokerEvt?.on ? null : await import("../Shared/sockets/registerSocketServer.js").then(m => (m as unknown as { globalBroker?: any }).globalBroker).catch(() => null);
                    const evtBroker = brokerEvt?.on ? brokerEvt : (globalMod as any);
                    // Try EventBroker instance fallback if no global
                    const ebFallback = !evtBroker?.on ? (await import("../EventBroker/eventBrokerGate.js").then(m => (m as any).EventBroker ? new (m as any).EventBroker() : null).catch(() => null)) : null;
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
                        const subId = targetBroker.on('approval.decided' as any, handler as any);
                        off = () => {
                          try {
                            if (typeof targetBroker.off === 'function') {
                              if (typeof subId === 'string') targetBroker.off('approval.decided' as any, subId);
                              else targetBroker.off('approval.decided' as any, handler as any);
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
                  pollBackoff = Math.min(2000, Math.round(pollBackoff * 1.6));
                };
                // Kick first poll quickly (300ms) then backoff
                timer = setTimeout(poll, 300);
                // Also hard TTL guard
                setTimeout(() => {
                  if (settled) return;
                  poll();
                }, pendingTtl + 2500).unref?.();
              });
            };

            const awaited = await waitForApprovalDecision();
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
                const { globalBroker } = await import("../Shared/sockets/registerSocketServer.js");
                const emitVia = globalBroker as unknown as { emit?: (t: string, p: unknown, o?: unknown) => void } | null;
                if (emitVia && typeof emitVia.emit === "function") {
                  emitVia.emit("approval.decided" as never, decidedPayload as never, { channelId: channelIdForEvent } as never);
                } else {
                  const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
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
          if (reason && !(reason instanceof ToolTimeoutError) && reason.message.includes("aborted by caller")) {
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
