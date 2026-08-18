import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { eq } from "drizzle-orm";

import { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { MentionParser } from "../core/mentionParser.js";
import { AgentRegistry } from "../../Agents/agentGate.js";
import { RuntimeExecutor } from "../../runtime/index.js";
import { IndexBuilder } from "../core/indexBuilder.js";
import { getDb } from "../config/database.js";
import { messages, agents, channels, workspaces, runtimeOverrides, spawnRequests } from "../../db/schema.js";
import type {
  SocketClientToServerEvents,
  SocketServerToClientEvents,
} from "../../EventBroker/eventBrokerGate.js";
import type { ChannelMessage } from "../../Messages/messageGate.js";
import type { AgentProfile } from "../../Agents/agentGate.js";
import { getNextSequenceNumber } from "../core/sequenceNumber.js";

const mentionParser = new MentionParser();
const agentRegistry = new AgentRegistry();
const executor = new RuntimeExecutor();
export let globalBroker: EventBroker | null = null;

// Agent execution is handled by RuntimeExecutor

async function triggerSystemWarning(broker: EventBroker, channelId: string, content: string): Promise<void> {
  const db = getDb();
  const nextSeq = await getNextSequenceNumber(channelId);

  const warningMsg: ChannelMessage = {
    id: `msg-${Date.now()}-system`,
    channelId,
    authorId: "system",
    authorName: "System Warning",
    authorLevel: "stakeholder",
    authorType: "system",
    content,
    mentions: [],
    isInternalMonologue: false,
    sequenceNumber: nextSeq,
    timestamp: new Date(),
  };

  await db.insert(messages).values({
    ...warningMsg,
    authorLevel: String(warningMsg.authorLevel),
  });
  broker.emit("message:new", warningMsg, { channelId });
}

async function emitRuntimeSnapshot(target: any): Promise<void> {
  try {
    const db = getDb();
    const dbWorkspaces = await db.query.workspaces.findMany();
    const dbAgents = await db.query.agents.findMany();
    const dbOverrides = await db.query.runtimeOverrides.findMany();
    const activeSpawns = await db.query.spawnRequests.findMany({
      where: (table, { eq }) => eq(table.status, "in_progress"),
    });

    const swarms = activeSpawns.map(spawn => ({
      swarmId: spawn.id,
      name: `Swarm ${spawn.id.slice(0, 8)}`,
      status: "active" as const,
      members: [spawn.requestedBy, spawn.workerTemplateId, spawn.supervisorTemplateId].filter(Boolean),
      activeTasksCount: spawn.subtasks ? (spawn.subtasks as any[]).length : 0,
      createdAt: spawn.createdAt.toISOString(),
    }));

    const snapshot = {
      workspaces: dbWorkspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        ownerId: ws.ownerId,
        status: ws.status,
        rootPath: ws.rootPath,
        permissions: ws.permissions,
        constraints: ws.constraints,
        metadata: ws.metadata || {},
        createdAt: ws.createdAt.toISOString(),
        updatedAt: ws.updatedAt.toISOString(),
      })),
      agents: dbAgents.map(ag => ({
        id: ag.id,
        name: ag.name,
        title: ag.title,
        species: ag.species || "Raven",
        avatar: ag.avatar || "🤖",
        authorityLevel: ag.authorityLevel,
        status: ag.status || "idle",
        instructionModuleId: ag.instructionModuleId,
        modelModuleId: ag.modelModuleId,
        toolkitModuleId: ag.toolkitModuleId,
        isOmniscient: ag.isOmniscient || false,
        createdAt: ag.createdAt.toISOString(),
        updatedAt: ag.updatedAt.toISOString(),
      })),
      swarms,
      escalations: [],
      sandboxes: dbWorkspaces.map(ws => ({
        sandboxId: `sb-${ws.id}`,
        workspaceId: ws.id,
        status: "idle" as const,
        activeProcesses: [],
        memoryUsedMb: 42,
        cpuUsagePercent: 1.5,
        lastUpdated: new Date().toISOString(),
      })),
      overrides: dbOverrides.map(ov => ({
        id: ov.id,
        agentId: ov.targetAgentId,
        type: ov.overrideType === "runtime_patch" ? "instruction" : "model",
        patch: (ov.instructionPatch || ov.permissionPatch || {}) as Record<string, any>,
        reason: ov.createdBy,
        active: true,
        createdAt: ov.createdAt.toISOString(),
      })),
      runtimeHealth: {
        status: "healthy" as const,
        timestamp: new Date().toISOString(),
      },
    };

    target.emit("runtime:snapshot", snapshot);
  } catch (err) {
    console.error("[registerSocketServer] Failed to emit runtime snapshot:", err);
  }
}

export function registerSocketServer(httpServer: HttpServer, broker: EventBroker) {
  globalBroker = broker;
  const io = new Server<SocketClientToServerEvents, SocketServerToClientEvents>(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  broker.onAny((event) => {
    io.emit(event.type, event.payload as never);
  });

  // Register permanent index count listener for all new messages!
  broker.on("message:new", undefined, async (event) => {
    try {
      const msg = event.payload;
      await IndexBuilder.incrementMessageCount(msg.channelId);
    } catch (err) {
      console.error("[EventBroker] Failed to increment channel message count:", err);
    }
  });

  // Setup periodic background indexing for stale channels (drift >= 10 messages) every 10 minutes
  setInterval(async () => {
    try {
      await IndexBuilder.reindexStaleChannels(broker);
    } catch (err) {
      console.error("[IndexBuilder] Background reindexing task failed:", err);
    }
  }, 10 * 60 * 1000);

  // Periodic snapshot broadcast to prevent drift (every 15 seconds)
  const snapshotInterval = setInterval(() => {
    emitRuntimeSnapshot(io);
  }, 15000);

  io.on("connection", (socket) => {
    // Immediately emit snapshot on connection
    emitRuntimeSnapshot(socket);

    socket.on("user:message", async (payload) => {
      const db = getDb();
      const { channelId, content } = payload;

      try {
        // 1. Resolve and parse mentions from content
        const resolvedMentions = await mentionParser.parseMentions(content);

        // 2. Persist the human operator's message
        const nextSeq = await getNextSequenceNumber(channelId);
        const userMsg: ChannelMessage = {
          id: `msg-${Date.now()}`,
          channelId,
          authorId: "user-1",
          authorName: "Juan Hamzah",
          authorLevel: "stakeholder",
          authorType: "user",
          content,
          mentions: resolvedMentions,
          isInternalMonologue: false,
          sequenceNumber: nextSeq,
          timestamp: new Date(),
        };

        await db.insert(messages).values({
          ...userMsg,
          authorLevel: String(userMsg.authorLevel),
        });
        broker.emit("message:new", userMsg, { channelId });

        // 3. Process mentions and triggers
        const allAgents = await agentRegistry.list({ isTemplate: false });

        if (resolvedMentions.length > 0) {
          // Explicit mentions are present
          for (const mention of resolvedMentions) {
            if (mention.type === "agent") {
              const agent = allAgents.find(a => a.id === mention.targetId);
              if (agent) {
                if (agent.status === "paused") {
                  await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently paused.`);
                } else if (agent.status === "offline") {
                  await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently offline.`);
                } else {
                  await executor.execute({
                    agent,
                    channelId,
                    workspaceId: 'default',
                    userInput: content,
                    broker,
                    librarianAgentId: 'agent-librarian',
                  });
                }
              }
            } else if (mention.type === "role") {
              // Role mention, e.g. @Level2, L0, L1, etc.
              // Find matching role level: e.g. "role-l2" -> level 2
              const levelStr = mention.targetId.replace("role-l", "");
              const levelNum = parseInt(levelStr, 10);
              if (!isNaN(levelNum)) {
                const matchingAgents = allAgents.filter(a => a.authorityLevel === levelNum);
                for (const agent of matchingAgents) {
                  if (agent.status === "paused") {
                    await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently paused.`);
                  } else if (agent.status === "offline") {
                    await triggerSystemWarning(broker, channelId, `Agent @${agent.name} is currently offline.`);
                  } else {
                    await executor.execute({
                      agent,
                      channelId,
                      workspaceId: 'default',
                      userInput: content,
                      broker,
                      librarianAgentId: 'agent-librarian',
                    });
                  }
                }
              }
            }
          }
        } else {
          // No explicit mentions
          // Check if this is the #general channel
          const channel = await db.query.channels.findFirst({
            where: eq(channels.id, channelId),
          });
          const isGeneral = channel?.name.toLowerCase() === "general";

          if (isGeneral) {
            // Trigger all active L0 agents in parallel
            const l0Agents = allAgents.filter(a => a.authorityLevel === 0);
            for (const agent of l0Agents) {
              if (agent.status !== "offline" && agent.status !== "paused") {
                executor.execute({
                  agent,
                  channelId,
                  workspaceId: 'default',
                  userInput: content,
                  broker,
                });
              }
            }
          }
        }
      } catch (error: any) {
        console.error("Error in user:message handler:", error);
        await triggerSystemWarning(broker, channelId, `System error processing message: ${error?.message || error}`);
      }
    });
  });

  return io;
}
