import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { agents, runtimeStates, messages } from "../db/schema.js";
import type { EventBroker } from "../EventBroker/eventBrokerGate.js";
import type { AgentProfile } from "./agentTypes.js";
import type { ChannelMessage } from "../Messages/messageGate.js";
import { getNextSequenceNumber } from "../Shared/core/sequenceNumber.js";
import { monotonicUlid } from "../Shared/core/ulid.js";

export type AgentErrorType =
  | "LLM_API_ERROR"
  | "MALFORMED_OUTPUT"
  | "TOOL_FAILURE"
  | "LOOP_DETECTED"
  | "SUPERVISOR_REJECTION"
  | "CONTEXT_OVERFLOW"
  | "BUDGET_EXCEEDED";

export class AgentError extends Error {
  constructor(
    public errorType: AgentErrorType,
    message: string,
    public errorCode?: number
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class EscalationChain {
  /**
   * Escalates an agent error to the higher authority level:
   * L3 Worker/Supervisor -> L2 Coordinator -> L1 CEO -> User Notification
   */
  static async escalate(
    broker: EventBroker,
    agent: AgentProfile,
    channelId: string,
    errorType: AgentErrorType,
    errorMessage: string
  ): Promise<void> {
    const db = getDb();
    console.log(`[EscalationChain] Escalating error from @${agent.name} (L${agent.authorityLevel}): ${errorMessage}`);

    // Escalation tenancy follows its channel (hard error, no silent default).
    const { channels } = await import("../db/schema.js");
    const escChannel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    const escWorkspace = (escChannel as { workspaceId?: string | null } | null)?.workspaceId;
    if (!escWorkspace) {
      throw new Error(`[EscalationChain] Refusing to escalate in channel ${channelId} without workspace scope.`);
    }

    // Emit real-time escalation:created event to the projection layer
    broker.emit("escalation:created", {
      id: `esc-${Date.now()}`,
      type: errorType === "LOOP_DETECTED" ? "loop_detected" : "warning",
      agentId: agent.id,
      message: errorMessage,
      timestamp: new Date().toISOString(),
      details: { channelId }
    }, { channelId, workspaceId: escWorkspace });

    // If loop was detected, trigger a formal Swarm Strike
    if (errorType === "LOOP_DETECTED") {
      broker.emit("strike:initiated" as any, {
        agentId: agent.id,
        strikeCount: 1,
        maxStrikes: 3,
        reason: "Infinite self-loop detected. 3 consecutive generated outputs show high lexical similarity >= 0.9.",
        channelId,
        timestamp: new Date().toISOString()
      }, { channelId, workspaceId: escWorkspace });
    }

    // 1. Pause the failing agent
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
    broker.emit("agent:status", { agentId: agent.id, status: "paused" }, { channelId, workspaceId: escWorkspace });
    broker.emit("agent:paused", { agentId: agent.id, reason: `${errorType}: ${errorMessage}` }, { channelId, workspaceId: escWorkspace });

    // Update RuntimeState
    const [state] = await db.select().from(runtimeStates).where(eq(runtimeStates.agentId, agent.id)).limit(1);
    if (state) {
      await db.update(runtimeStates)
        .set({
          status: "paused",
          errorInfo: {
            code: errorType,
            message: errorMessage,
            timestamp: new Date().toISOString()
          }
        })
        .where(eq(runtimeStates.agentId, agent.id));
    }

    // 2. Resolve escalation target
    let escalatedTo = "User (Stakeholder)";
    let targetLevel: 0 | 1 | 2 | 3 | null = null;

    if (agent.authorityLevel === 3) {
      // Escalate worker to L2 Coordinator
      targetLevel = 2;
    } else if (agent.authorityLevel === 2) {
      // Escalate L2 Coordinator to L1 CEO
      targetLevel = 1;
    } else if (agent.authorityLevel === 1) {
      // Escalate L1 CEO to User
      targetLevel = null;
    }

    const nextSeq = await getNextSequenceNumber(channelId);

    if (targetLevel !== null) {
      // Find active coordinators at targetLevel
      const allAgents = await db.query.agents.findMany({
        where: and(eq(agents.isTemplate, false), isNull(agents.archivedAt)),
      });
      const targetAgent = allAgents.find(a => a.authorityLevel === targetLevel && a.status !== "offline" && a.status !== "paused");

      if (targetAgent) {
        escalatedTo = targetAgent.id;
        const msgContent = `[ESCALATION] ⚠️ Agent @${agent.name} (L${agent.authorityLevel}) encountered error [${errorType}]: "${errorMessage}". Escalating to @${targetAgent.name} (L${targetAgent.authorityLevel}) for resolution.`;

        const escMsg: ChannelMessage = {
          id: monotonicUlid(),
          workspaceId: escWorkspace,
          channelId,
          authorId: "system",
          authorName: "System Safety Monitor",
          authorLevel: "stakeholder",
          authorType: "system",
          content: msgContent,
          mentions: [{ type: "agent", targetId: targetAgent.id, targetName: targetAgent.name, position: 0, flag: "escalation" }],
          isInternalMonologue: false,
          sequenceNumber: nextSeq,
          timestamp: new Date(),
        };

        await db.insert(messages).values({
          ...escMsg,
          authorLevel: String(escMsg.authorLevel),
        });
        broker.emit("message:new", escMsg, { channelId, workspaceId: escWorkspace });

        // Trigger active target agent status
        await db.update(agents).set({ status: "working" }).where(eq(agents.id, targetAgent.id));
        broker.emit("agent:status", { agentId: targetAgent.id, status: "working" }, { channelId, workspaceId: escWorkspace });
        broker.emit("agent:thinking", { agentId: targetAgent.id, channelId }, { channelId, workspaceId: escWorkspace });

        setTimeout(async () => {
          const replyContent = `I am @${targetAgent.name}, L${targetAgent.authorityLevel} Coordinator. I have taken over the error escalation from @${agent.name}. Examining error stack and initializing fallback pipelines.`;
          const replySeq = await getNextSequenceNumber(channelId);
          const replyMsg: ChannelMessage = {
            id: monotonicUlid(),
            workspaceId: escWorkspace,
            channelId,
            authorId: targetAgent.id,
            authorName: targetAgent.name,
            authorLevel: targetAgent.authorityLevel as any,
            authorType: "agent",
            content: replyContent,
            mentions: [],
            isInternalMonologue: false,
            sequenceNumber: replySeq,
            timestamp: new Date(),
          };

          await db.insert(messages).values({
            ...replyMsg,
            authorLevel: String(replyMsg.authorLevel),
          });
          broker.emit("message:new", replyMsg, { channelId, workspaceId: escWorkspace });

          await db.update(agents).set({ status: "idle" }).where(eq(agents.id, targetAgent.id));
          broker.emit("agent:status", { agentId: targetAgent.id, status: "idle" }, { channelId, workspaceId: escWorkspace });
        }, 1200);

        return;
      }
    }

    // Direct User Escalation
    const userMsgContent = `[EMERGENCY NOTIFICATION] 🚨 Fatal escalation block reached. Agent @${agent.name} (L${agent.authorityLevel}) encountered unresolved error [${errorType}]: "${errorMessage}". System swarm paused. Operator intervention required! Opsi: Reset budget, update agent prompt, or clear Sandbox files.`;

    const userMsg: ChannelMessage = {
      id: monotonicUlid(),
      workspaceId: escWorkspace,
      channelId,
      authorId: "system",
      authorName: "System Warning",
      authorLevel: "stakeholder",
      authorType: "system",
      content: userMsgContent,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: nextSeq,
      timestamp: new Date(),
    };

    await db.insert(messages).values({
      ...userMsg,
      authorLevel: String(userMsg.authorLevel),
    });
    broker.emit("message:new", userMsg, { channelId, workspaceId: escWorkspace });
    broker.emit("budget:exceeded", { profileId: agent.modelModuleId || "default", pausedAgents: [agent.id] }, { channelId, workspaceId: escWorkspace });
  }
}
