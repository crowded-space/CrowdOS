import { queueGate } from "./Queue/queueGate.js";
import { runtimeGate } from "./runtime/runtimeGate.js";
import { agentGate } from "./Agents/agentGate.js";
import { memoriesGate } from "./Memories/memoriesGate.js";
import { getDb, closeDatabaseConnection } from "./Shared/config/database.js";

async function main() {
  console.log("[worker] booting — QUEUE_MODE=", process.env.QUEUE_MODE ?? "inline");
  console.log("[worker] connecting to DB…");
  try {
    getDb();
    console.log("[worker] DB connection established");
  } catch (err) {
    console.error("[worker] DB connection failed", err);
    process.exit(1);
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

  // APR-1: approval sweeper also runs in worker for bullmq deployments (idempotent)
  try {
    const { startApprovalSweeper } = await import("./Approvals/approvalSweeper.js");
    const { EventBroker } = await import("./EventBroker/eventBrokerGate.js");
    startApprovalSweeper(new EventBroker());
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
  async function drainAndExit(signal: string) {
    if (isDraining) return;
    isDraining = true;
    console.log(`[worker] ${signal} received — draining queues…`);
    try {
      await queueGate.drain();
      await closeDatabaseConnection();
      console.log("[worker] drain complete, exiting");
      process.exit(0);
    } catch (err) {
      console.error("[worker] drain error", err);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void drainAndExit("SIGTERM"));
  process.on("SIGINT", () => void drainAndExit("SIGINT"));

  console.log("[worker] ready — waiting for jobs");
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
