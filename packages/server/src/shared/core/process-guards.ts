// ─── Process-level crash guards (CrowdOS §28 state-driven, honest failure) ──
//
// Node's default for an unhandled promise rejection is to crash the process
// (Node >=15). For a single-user local-first app that is the worst possible
// outcome: an orphaned background task — a reindex tick, an outbox drain, a
// fire-and-forget usage write — would take down the API the user is typing
// into, mid-run, losing the in-flight conversation.
//
// The deliberate policy here is therefore:
//   * LOG LOUDLY, DO NOT EXIT. Every rejection is recorded with redaction and
//     a structured counter so it is observable rather than silent.
//   * NEVER SWALLOW. The handler always emits; it never returns quietly.
//   * COUNTED, NOT DEDUPED. Every rejection increments a monotonic counter that
//     rides the structured log, so a storm is visible as a rising count rather
//     than as N identical lines. (No time-window suppression is implemented:
//     dropping a rejection silently is worse than a noisy log.)
//
// This is deliberately NOT a blanket try/catch: request paths, runtimes and
// queue jobs keep their own error handling (which is where correctness lives).
// These guards only cover the detached work that has no caller left to catch.

import { logMetric } from "./structured-log.js";
import { redactLogPayload } from "./redact.js";

/** Identifies which process installed the guards (server / worker / desktop). */
export type ProcessGuardRole = "server" | "worker" | "desktop";

export interface ProcessGuardOptions {
  role: ProcessGuardRole;
  /** Called after a rejection is logged. Defaults to no-op (log-and-continue). */
  onUnhandledRejection?: (reason: unknown) => void;
}

let installed = false;
let rejectionCount = 0;

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack };
  }
  if (typeof reason === "string") return { message: reason };
  try {
    return { message: JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

/**
 * Install process-level guards. Idempotent — calling twice is a no-op, so a
 * boot path that both imports and calls it cannot double-register listeners.
 */
export function installProcessGuards(options: ProcessGuardOptions): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason: unknown) => {
    rejectionCount += 1;
    const { message, stack } = describe(reason);
    logMetric({
      stage: "process.unhandled_rejection",
      role: options.role,
      count: rejectionCount,
      error: redactLogPayload({ message, stack: stack?.split("\n").slice(0, 4).join("\n") }),
    });
    console.error(
      `[process-guards] Unhandled promise rejection #${rejectionCount} (${options.role}): ${message}`,
    );
    try {
      options.onUnhandledRejection?.(reason);
    } catch (handlerErr) {
      // A broken observer must not turn a logged rejection into a crash.
      console.error("[process-guards] onUnhandledRejection hook threw:", handlerErr);
    }
  });

  // An uncaught exception is a genuinely broken invariant (a throw outside any
  // async context). The same policy applies: record it, keep serving. The
  // alternative — dying silently on a user's desktop — is strictly worse than
  // continuing with one degraded path.
  process.on("uncaughtException", (err: Error) => {
    logMetric({
      stage: "process.uncaught_exception",
      role: options.role,
      error: redactLogPayload({
        message: err?.message,
        name: err?.name,
        stack: err?.stack?.split("\n").slice(0, 4).join("\n"),
      }),
    });
    console.error(`[process-guards] Uncaught exception (${options.role}):`, err);
  });
}

/** Test seam: reset install state and counters. */
export function resetProcessGuardsForTests(): void {
  installed = false;
  rejectionCount = 0;
}

/** Test seam: number of rejections observed by this process. */
export function processGuardRejectionCount(): number {
  return rejectionCount;
}
