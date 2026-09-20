import { queueGate } from "./queue/queue-gate.js";
import { runtimeGate } from "./runtime/runtime-gate.js";
import { agentGate } from "./agents/agent-gate.js";
import { memoriesGate } from "./memories/memories-gate.js";
import { getDb, closeDatabaseConnection } from "./shared/config/database.js";

async function main() {
  console.log("[worker] booting — QUEUE_MODE=", process.env.QUEUE_MODE ?? "inline");
  // Record-only DB: the worker needs a database solely for bullmq durable
  // execution (per-workspace pools resolve per job). Inline mode is fully
  // local — a missing env URL must not fail boot.
  if (queueGate.mode() === "bullmq") {
    console.log("[worker] connecting to DB…");
    try {
      getDb();
      console.log("[worker] DB connection established");
    } catch (err) {
      console.error("[worker] DB connection failed", err);
      process.exit(1);
    }
  } else {
    console.log("[worker] no env database configured — local-only inline mode");
  }

  runtimeGate.init();
  console.log("[worker] runtime initialized");

  void agentGate;
  void memoriesGate;

  if (queueGate.mode() !== "bullmq") {
    console.log("[worker] QUEUE_MODE=inline — worker has no jobs to process; exiting.");
    console.log("[worker] Set QUEUE_MODE=bullmq and REDIS_URL to enable durable execution.");
    process.exit(0);
  }

  // APR-1: approval sweeper also runs in worker for bullmq deployments (idempotent).
  // Worker-local shared instance: no socket server in this process (documented).
  try {
    const { startApprovalSweeper } = await import("./approvals/approval-sweeper.js");
    const { EventBroker, setSharedBroker } = await import("./event-broker/event-broker-gate.js");
    const workerBroker = new EventBroker();
    setSharedBroker(workerBroker);
    startApprovalSweeper(workerBroker);
  } catch {}

  console.log("[worker] scheduling maintenance repeatables and starting workers…");
  try {
    await queueGate.scheduleMaintenance();
    // TOOL-1: ensure scheduler worker is also running so system_scheduler delayed/repeatable jobs fire
    try {
      await queueGate.startSchedulerWorker();
    } catch (e) {
      console.warn("[worker] scheduler worker start failed (non-fatal)", (e as Error)?.message || e);
    }
    console.log("[worker] workers ready — run queue, maintenance + scheduler repeatables scheduled");
  } catch (err) {
    console.error("[worker] failed to schedule maintenance", err);
    process.exit(1);
  }

  let isDraining = false;
  const DRAIN_TIMEOUT_MS = 30000;
  async function drainAndExit(signal: string) {
    if (isDraining) {
      console.error(`[worker] ${signal} received during drain — force exiting`);
      process.exit(1);
    }
    isDraining = true;
    console.log(`[worker] ${signal} received — draining queues…`);
    let drainFailed = false;
    try {
      // Bound the graceful close so a stuck job can't hold shutdown forever; DB still closes below.
      await Promise.race([
        queueGate.drain(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`drain timed out after ${DRAIN_TIMEOUT_MS}ms`)), DRAIN_TIMEOUT_MS);
          t.unref?.();
        }),
      ]);
    } catch (err) {
      drainFailed = true;
      console.error("[worker] drain error", err);
    }
    try {
      await closeDatabaseConnection();
    } catch (err) {
      console.error("[worker] db close error", err);
      process.exit(1);
    }
    console.log("[worker] drain complete, exiting");
    process.exit(drainFailed ? 1 : 0);
  }

  process.on("SIGTERM", () => void drainAndExit("SIGTERM"));
  process.on("SIGINT", () => void drainAndExit("SIGINT"));

  console.log("[worker] ready — waiting for jobs");
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
