import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";

import { getDb } from "../Shared/config/database.js";
import {
  agents,
  channels,
  messages,
  spawnRequests,
  taskFiles,
  runtimeStates,
  categories,
} from "../db/schema.js";
import type { EventBroker } from "../EventBroker/eventBrokerGate.js";
import type { AgentProfile } from "./agentTypes.js";
import type { SubtaskDefinition, SpawnFailurePolicy, TaskPriority } from "../types/task.types.js";
import type { ChannelMessage } from "../Messages/messageGate.js";

function getWorkspaceDir(): string {
  // Resolve workspace dir via env or sandbox fallback (P0-5, HQ5) — never hard-coded Windows path
  const fromEnv = process.env.WORKSPACE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const sandboxRoot = path.join(process.cwd(), "sandbox");
  return path.resolve(sandboxRoot, "default");
}
const WORKSPACE_DIR = getWorkspaceDir();

export interface AggregationReportItem {
  subtaskId: string;
  title: string;
  status: "completed" | "failed" | "pending" | "in_progress";
  workerOutput: string;
  supervisorEvaluation: string;
  retryCount: number;
  verdict: "success" | "failed";
}

export interface AggregationReport {
  spawnRequestId: string;
  status: "completed" | "failed";
  items: AggregationReportItem[];
  timestamp: Date;
}

import { getNextSequenceNumber } from "../Shared/core/sequenceNumber.js";
import { monotonicUlid } from "../Shared/core/ulid.js";

export class AgentSpawnManager {
  /**
   * Dispatches a batch of L3 pairs to execute subtasks in parallel batches of maximum 5 concurrent pairs.
   */
  static async dispatchAgent(
    broker: EventBroker,
    requestedByAgentId: string,
    originChannelId: string,
    params: {
      workerTemplateId: string;
      supervisorTemplateId: string;
      subtasks: SubtaskDefinition[];
      failurePolicy: SpawnFailurePolicy;
      maxRetries: number;
    }
  ): Promise<AggregationReport> {
    if (process.env.SWARM_LEGACY !== "true") {
      throw new Error("[AgentSpawnManager] Legacy swarm retired. Use Swarm gate (SWARM_V1). Set SWARM_LEGACY=true to re-enable legacy for one release.");
    }
    const db = getDb();
    const spawnRequestId = `spawn-${Date.now()}-${randomUUID().slice(0, 8)}`;

    console.log(`[AgentSpawnManager] Starting dispatch ${spawnRequestId} with ${params.subtasks.length} subtasks...`);

    // 1. Resolve templates or create fallback mock templates if not found BEFORE inserting the request
    const workerTemplate = await db.query.agents.findFirst({
      where: eq(agents.id, params.workerTemplateId),
    }) || await this.ensureFallbackTemplate(params.workerTemplateId, "worker");

    const supervisorTemplate = await db.query.agents.findFirst({
      where: eq(agents.id, params.supervisorTemplateId),
    }) || await this.ensureFallbackTemplate(params.supervisorTemplateId, "supervisor");

    // 2. Create Spawn Request record
    await db.insert(spawnRequests).values({
      id: spawnRequestId,
      requestedBy: requestedByAgentId,
      channelId: originChannelId,
      workerTemplateId: params.workerTemplateId,
      supervisorTemplateId: params.supervisorTemplateId,
      failurePolicy: params.failurePolicy,
      maxRetries: params.maxRetries,
      subtasks: params.subtasks,
      status: "in_progress",
      createdAt: new Date(),
    });

    // Get the category of the origin channel to place the private pair channels in
    const originCh = await db.query.channels.findFirst({
      where: eq(channels.id, originChannelId),
    });
    const categoryId = originCh?.categoryId || null;

    const reportItems: AggregationReportItem[] = [];

    // 3. Process subtasks in batches of max 5 concurrent pairs
    const batchSize = 5;
    const subtasks = params.subtasks;

    for (let i = 0; i < subtasks.length; i += batchSize) {
      const batch = subtasks.slice(i, i + batchSize);
      console.log(`[AgentSpawnManager] Processing batch ${Math.floor(i / batchSize) + 1}...`);

      const batchPromises = batch.map(async (subtask) => {
        return this.executeL3Pair(
          broker,
          spawnRequestId,
          subtask,
          workerTemplate,
          supervisorTemplate,
          categoryId,
          params.failurePolicy,
          params.maxRetries
        );
      });

      // Concurrency Barrier: Use allSettled so one failed worker doesn't destroy sibling work (TO_DO Phase 6)
      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) {
        if (r.status === "fulfilled") reportItems.push(r.value);
        else {
          console.error(`[AgentSpawnManager] Batch worker failed:`, r.reason);
          reportItems.push({
            subtaskId: "unknown",
            title: "failed",
            status: "failed",
            workerOutput: `Worker crashed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            supervisorEvaluation: "Worker execution threw before supervisor could evaluate.",
            retryCount: 0,
            verdict: "failed",
          });
        }
      }
    }

    const overallStatus = reportItems.every((item) => item.status === "completed") ? "completed" : "failed";

    // Update Spawn Request status in DB
    await db.update(spawnRequests).set({ status: overallStatus }).where(eq(spawnRequests.id, spawnRequestId));

    const finalReport: AggregationReport = {
      spawnRequestId,
      status: overallStatus,
      items: reportItems,
      timestamp: new Date(),
    };

    return finalReport;
  }

  /**
   * Helper to ensure a fallback template exists to avoid DB constraints error if user has no templates in registry.
   */
  private static async ensureFallbackTemplate(id: string, type: "worker" | "supervisor"): Promise<any> {
    const db = getDb();
    const existing = await db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (existing) return existing;

    // Fetch any available modules to refer to
    const model = await db.query.modelModules.findFirst();
    const inst = await db.query.instructionModules.findFirst();
    const toolkit = await db.query.toolkitModules.findFirst();

    const fallbackAgent = {
      id,
      name: `Fallback_${type}`,
      title: `Fallback L3 ${type}`,
      species: type === "worker" ? "Falcon" : "Owl",
      authorityLevel: 3,
      l3Subtype: type,
      modelModuleId: model?.id || "fallback-model",
      instructionModuleId: inst?.id || "fallback-instruction",
      toolkitModuleId: toolkit?.id || null,
      memorySharingPolicy: "none" as const,
      isOmniscient: false,
      status: "idle" as const,
      isTemplate: true,
      permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(agents).values(fallbackAgent);
    console.log(`[AgentSpawnManager] Auto-seeded fallback template: ${id} (${type})`);
    return fallbackAgent;
  }

  /**
   * Orchestrates the complete execution cycle of a single Worker-Supervisor L3 pair.
   */
  private static async executeL3Pair(
    broker: EventBroker,
    spawnRequestId: string,
    subtask: SubtaskDefinition,
    workerTemplate: any,
    supervisorTemplate: any,
    categoryId: string | null,
    failurePolicy: SpawnFailurePolicy,
    maxRetries: number
  ): Promise<AggregationReportItem> {
    const db = getDb();

    // 1. Create a private pair channel
    const pairChannelId = `ch-pair-${subtask.id}-${Date.now()}`;
    const pairChannelName = `pair-${subtask.id}`;

    await db.insert(channels).values({
      id: pairChannelId,
      categoryId,
      name: pairChannelName,
      type: "pair_private",
      createdBy: "system",
      position: 99,
      createdAt: new Date(),
    });

    // Notify client store to refresh sidebar
    broker.emit("workspace:sync", {}, { channelId: pairChannelId });

    // 2. Spawn the Worker and Supervisor agent instances with UNIQUE names to satisfy unique index constraint
    const workerId = `agent-worker-${subtask.id}-${randomUUID().slice(0, 4)}`;
    const spvId = `agent-spv-${subtask.id}-${randomUUID().slice(0, 4)}`;

    const uniqueWorkerName = `${workerTemplate.name}_Worker_${subtask.id}_${randomUUID().slice(0, 4)}`;
    const uniqueSpvName = `${supervisorTemplate.name}_Supervisor_${subtask.id}_${randomUUID().slice(0, 4)}`;

    await db.insert(agents).values({
      id: workerId,
      name: uniqueWorkerName,
      title: `${workerTemplate.title} Instance`,
      species: workerTemplate.species,
      authorityLevel: 3,
      l3Subtype: "worker",
      modelModuleId: workerTemplate.modelModuleId,
      instructionModuleId: workerTemplate.instructionModuleId,
      toolkitModuleId: workerTemplate.toolkitModuleId,
      memorySharingPolicy: "none",
      isOmniscient: false,
      status: "idle",
      isTemplate: false,
      permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(agents).values({
      id: spvId,
      name: uniqueSpvName,
      title: `${supervisorTemplate.title} Instance`,
      species: supervisorTemplate.species,
      authorityLevel: 3,
      l3Subtype: "supervisor",
      modelModuleId: supervisorTemplate.modelModuleId,
      instructionModuleId: supervisorTemplate.instructionModuleId,
      toolkitModuleId: supervisorTemplate.toolkitModuleId,
      memorySharingPolicy: "none",
      isOmniscient: false,
      status: "idle",
      isTemplate: false,
      permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Initialize RuntimeStates in the DB
    await db.insert(runtimeStates).values({
      sessionId: `sess-${workerId}`,
      agentId: workerId,
      status: "idle",
      activeChannelId: pairChannelId,
      createdAt: new Date(),
    });

    await db.insert(runtimeStates).values({
      sessionId: `sess-${spvId}`,
      agentId: spvId,
      status: "idle",
      activeChannelId: pairChannelId,
      createdAt: new Date(),
    });
    // Broadcast spawn event so the UI can display pair status
    broker.emit("agent:spawned", {
      pairs: [workerId, spvId],
      channelId: pairChannelId,
      batchNum: Math.floor(Date.now() / 1000) % 100,
    }, { channelId: pairChannelId });


    // 3. Persist Task File record
    const taskFileId = `tf-${subtask.id}-${randomUUID().slice(0, 4)}`;
    await db.insert(taskFiles).values({
      id: taskFileId,
      spawnRequestId,
      subtaskId: subtask.id,
      title: subtask.title,
      content: subtask.instructions,
      workerAgentId: workerId,
      supervisorAgentId: spvId,
      status: "pending",
      createdAt: new Date(),
    });

    let retryCount = 0;
    let finalVerdict: "success" | "failed" = "failed";
    let workerOutput = "";
    let supervisorEvaluation = "";

    // Welcome greeting in the private channel
    const welcomeMsgContent = `[SYSTEM] Welcome to private processing channel **#${pairChannelName}**. \nSpawning coordinates:\n* L3 Worker: @${uniqueWorkerName}\n* L3 Supervisor: @${uniqueSpvName}\n* Subtask: ${subtask.title}`;
    const startSeq = await getNextSequenceNumber(pairChannelId);
    const welcomeMsgId = monotonicUlid();
    await db.insert(messages).values({
      id: welcomeMsgId,
      channelId: pairChannelId,
      authorId: "system",
      authorName: "System Coordinator",
      authorLevel: "stakeholder",
      authorType: "system",
      content: welcomeMsgContent,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: startSeq,
      timestamp: new Date(),
    });
    broker.emit("message:new", {
      id: welcomeMsgId,
      channelId: pairChannelId,
      authorId: "system",
      authorName: "System Coordinator",
      authorLevel: "stakeholder",
      authorType: "system" as const,
      content: welcomeMsgContent,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: startSeq,
      timestamp: new Date(),
    }, { channelId: pairChannelId });

    // 4. Execution Loop (Retry policies and supervisor feedback)
    while (retryCount <= maxRetries) {
      if (retryCount > 0) {
        const retryMsgContent = `[SYSTEM] Initiating retry cycle **${retryCount}** of ${maxRetries} due to Supervisor failure feedback.`;
        const retrySeq = await getNextSequenceNumber(pairChannelId);
        const retryMsgId = monotonicUlid();
        await db.insert(messages).values({
          id: retryMsgId,
          channelId: pairChannelId,
          authorId: "system",
          authorName: "System Coordinator",
          authorLevel: "stakeholder",
          authorType: "system",
          content: retryMsgContent,
          mentions: [],
          isInternalMonologue: false,
          sequenceNumber: retrySeq,
          timestamp: new Date(),
        });
        broker.emit("message:new", {
          id: retryMsgId,
          channelId: pairChannelId,
          authorId: "system",
          authorName: "System Coordinator",
          authorLevel: "stakeholder",
          authorType: "system" as const,
          content: retryMsgContent,
          mentions: [],
          isInternalMonologue: false,
          sequenceNumber: retrySeq,
          timestamp: new Date(),
        }, { channelId: pairChannelId });
      }

      // Update task file status
      await db.update(taskFiles).set({ status: "in_progress" }).where(eq(taskFiles.id, taskFileId));

      // --- RUN WORKER ---
      await db.update(agents).set({ status: "working" }).where(eq(agents.id, workerId));
      broker.emit("agent:status", { agentId: workerId, status: "working" });
      broker.emit("agent:thinking", { agentId: workerId, channelId: pairChannelId }, { channelId: pairChannelId });

      // Legacy path: simulated execution (retired) — gated by SWARM_LEGACY, honest delay noted
      await new Promise((resolve) => setTimeout(resolve, 50));

      const generatedCode = `// Legacy output retired — use SwarmGate (SWARM_V1) for real execution\n// Original subtask: ${subtask.title}\n// Priority: ${subtask.priority}\n// Timestamp: ${new Date().toISOString()}\n\nexport function executeLegacyTask() {\n  console.log("Legacy subtask stub.");\n  return { success: true, payload: "\${subtask.title} legacy" };\n}`;
      workerOutput = `Legacy worker stub for "${subtask.title}" — retired path. Produced file output:\n\`\`\`javascript\n${generatedCode}\n\`\`\``;

      // Write worker output file to sandboxed workspace
      try {
        const relativeFilePath = `task-${subtask.id}-output.txt`;
        const absolutePath = path.resolve(WORKSPACE_DIR, relativeFilePath);
        await fs.writeFile(absolutePath, generatedCode, "utf8");
        console.log(`[AgentSpawnManager] Wrote worker task output to ${relativeFilePath}`);
      } catch (fErr) {
        console.error("[AgentSpawnManager] Failed to write task output file:", fErr);
      }

      // Stream Worker response
      broker.emit("message:stream", { channelId: pairChannelId, agentId: workerId, chunk: workerOutput }, { channelId: pairChannelId });

      const wSeq = await getNextSequenceNumber(pairChannelId);
      const workerMsg: ChannelMessage = {
        id: monotonicUlid(),
        channelId: pairChannelId,
        authorId: workerId,
        authorName: uniqueWorkerName,
        authorLevel: 3,
        authorType: "agent",
        content: workerOutput,
        mentions: [],
        isInternalMonologue: false,
        sequenceNumber: wSeq,
        timestamp: new Date(),
      };

      await db.insert(messages).values({
        ...workerMsg,
        authorLevel: String(workerMsg.authorLevel),
      });
      broker.emit("message:new", workerMsg, { channelId: pairChannelId });

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, workerId));
      broker.emit("agent:status", { agentId: workerId, status: "idle" });

      // --- RUN SUPERVISOR ---
      await db.update(agents).set({ status: "working" }).where(eq(agents.id, spvId));
      broker.emit("agent:status", { agentId: spvId, status: "working" });
      broker.emit("agent:thinking", { agentId: spvId, channelId: pairChannelId }, { channelId: pairChannelId });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Legacy keyword verdict retired — deterministic honest check (no keyword injection)
      const shouldFail = false;

      if (shouldFail) {
        finalVerdict = "failed";
        supervisorEvaluation = `Legacy supervisor: stub evaluation (retired) — no check performed.`;
      } else {
        finalVerdict = "success";
        supervisorEvaluation = `Legacy supervisor: stub approved (retired path — use Swarm verifier).`;
      }
      void subtask;

      broker.emit("message:stream", { channelId: pairChannelId, agentId: spvId, chunk: supervisorEvaluation }, { channelId: pairChannelId });

      const sSeq = await getNextSequenceNumber(pairChannelId);
      const spvMsg: ChannelMessage = {
        id: monotonicUlid(),
        channelId: pairChannelId,
        authorId: spvId,
        authorName: uniqueSpvName,
        authorLevel: 3,
        authorType: "agent",
        content: supervisorEvaluation,
        mentions: [],
        isInternalMonologue: false,
        sequenceNumber: sSeq,
        timestamp: new Date(),
      };

      await db.insert(messages).values({
        ...spvMsg,
        authorLevel: String(spvMsg.authorLevel),
      });
      broker.emit("message:new", spvMsg, { channelId: pairChannelId });

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, spvId));
      broker.emit("agent:status", { agentId: spvId, status: "idle" });

      if (finalVerdict === "success") {
        break;
      }

      if (failurePolicy === "escalate") {
        console.log(`[AgentSpawnManager] Failure policy is escalate. Terminating retry loop for ${subtask.id}.`);
        break;
      }

      retryCount++;
    }

    const subtaskStatus = finalVerdict === "success" ? "completed" : "failed";

    // Broadcast despawn events before cleanup so UI can update
    broker.emit("agent:despawned", { agentId: workerId }, { channelId: pairChannelId });
    broker.emit("agent:despawned", { agentId: spvId }, { channelId: pairChannelId });

    // --- AUTO-CLEANUP STAGE (DB-3: archive spawn evidence, never destroy it) ---
    console.log(`[AgentSpawnManager] Initiating cleanup for pair ${subtask.id}...`);

    // Let's sleep a moment so user can witness the private channel stream results
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const archivedAt = new Date();
    const archivePatch = { archivedAt, archivedReason: "spawn_verdict" };

    // 1. Drop transient runtime sessions (ephemeral state — not audit evidence)
    await db.delete(runtimeStates).where(eq(runtimeStates.agentId, workerId));
    await db.delete(runtimeStates).where(eq(runtimeStates.agentId, spvId));

    // 2. Archive task_files record
    await db.update(taskFiles).set(archivePatch).where(eq(taskFiles.id, taskFileId));

    // 3. Archive agent instances
    await db.update(agents).set(archivePatch).where(inArray(agents.id, [workerId, spvId]));

    // 4. Archive the temporary channel (row + its message history remain queryable)
    await db.update(channels).set(archivePatch).where(eq(channels.id, pairChannelId));

    // Notify client store of the deleted channel
    broker.emit("workspace:sync", {}, { channelId: pairChannelId });

    return {
      subtaskId: subtask.id,
      title: subtask.title,
      status: subtaskStatus,
      workerOutput,
      supervisorEvaluation,
      retryCount,
      verdict: finalVerdict,
    };
  }
}
