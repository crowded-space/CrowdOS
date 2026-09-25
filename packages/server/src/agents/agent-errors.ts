import { agentRegistry } from "./agent-service.js";
import { messageGate } from "../messages/message-gate.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";
import type { AgentProfile } from "./agent-types.js";
import { randomUUID } from "node:crypto";

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
    console.log(`[EscalationChain] Escalating error from @${agent.name} (L${agent.authorityLevel}): ${errorMessage}`);

    // Emit real-time escalation:created event to the projection layer
    broker.emit("escalation:created", {
      id: `esc-${Date.now()}-${randomUUID().slice(0, 8)}`,
      type: errorType === "LOOP_DETECTED" ? "loop_detected" : "warning",
      agentId: agent.id,
      message: errorMessage,
      timestamp: new Date().toISOString(),
      details: { channelId }
    });

    // If loop was detected, trigger a formal Swarm Strike
    if (errorType === "LOOP_DETECTED") {
      broker.emit("strike:initiated" as any, {
        agentId: agent.id,
        strikeCount: 1,
        maxStrikes: 3,
        reason: "Infinite self-loop detected. 3 consecutive generated outputs show high lexical similarity >= 0.9.",
        channelId,
        timestamp: new Date().toISOString()
      });
    }

    // 1. Pause the failing agent (Agents owns agents.status + runtime_states)
    await agentRegistry.setStatus(agent.id, "paused", { broker, errorInfo: { code: errorType, message: errorMessage } });
    broker.emit("agent:paused", { agentId: agent.id, reason: `${errorType}: ${errorMessage}` });

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

    if (targetLevel !== null) {
      // Find active coordinators at targetLevel (registry branches to files locally).
      // Tenant scope (CrowdOS §1): a failing agent escalates inside its own
      // workspace; an unscoped legacy agent keeps the cross-workspace search.
      const allAgents = await agentRegistry.list(
        agent.workspaceId != null ? { isTemplate: false, workspaceId: agent.workspaceId } : { isTemplate: false },
      );
      const targetAgent = allAgents.find(a => a.authorityLevel === targetLevel && a.status !== "offline" && a.status !== "paused");

      if (targetAgent) {
        escalatedTo = targetAgent.id;
        const msgContent = `[ESCALATION] ⚠️ Agent @${agent.name} (L${agent.authorityLevel}) encountered error [${errorType}]: "${errorMessage}". Escalating to @${targetAgent.name} (L${targetAgent.authorityLevel}) for resolution.`;

        await messageGate.append(
          {
            channelId,
            authorId: "system",
            authorName: "System Safety Monitor",
            authorLevel: "stakeholder",
            authorType: "system",
            content: msgContent,
            mentions: [{ type: "agent", targetId: targetAgent.id, targetName: targetAgent.name, position: 0, flag: "escalation" }],
          },
          { broker }
        );

        // Trigger active target agent status (Agents owns the flip)
        await agentRegistry.setStatus(targetAgent.id, "working", { broker });
        broker.emit("agent:thinking", { agentId: targetAgent.id, channelId }, { channelId });

        // Delayed takeover reply. Every step is individually guarded so a
        // failed append can never leave the target stuck "working": the
        // status reset always runs.
        setTimeout(() => {
          void (async () => {
            try {
              const replyContent = `I am @${targetAgent.name}, L${targetAgent.authorityLevel} Coordinator. I have taken over the error escalation from @${agent.name}. Examining error stack and initializing fallback pipelines.`;
              await messageGate.append(
                {
                  channelId,
                  authorId: targetAgent.id,
                  authorName: targetAgent.name,
                  authorLevel: targetAgent.authorityLevel,
                  authorType: "agent",
                  content: replyContent,
                },
                { broker }
              );
            } catch (err) {
              console.error(
                `[EscalationChain] Takeover reply failed for @${targetAgent.name} (${targetAgent.id}):`,
                err instanceof Error ? err.message : err,
              );
            } finally {
              await agentRegistry
                .setStatus(targetAgent.id, "idle", { broker })
                .catch((err) => {
                  console.error(
                    `[EscalationChain] Failed to reset @${targetAgent.name} (${targetAgent.id}) to idle:`,
                    err instanceof Error ? err.message : err,
                  );
                });
            }
          })();
        }, 1200);

        return;
      }
    }

    // Direct User Escalation
    const userMsgContent = `[EMERGENCY NOTIFICATION] 🚨 Fatal escalation block reached. Agent @${agent.name} (L${agent.authorityLevel}) encountered unresolved error [${errorType}]: "${errorMessage}". System swarm paused. Operator intervention required! Opsi: Reset budget, update agent prompt, or clear Sandbox files.`;

    await messageGate.append(
      {
        channelId,
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "stakeholder",
        authorType: "system",
        content: userMsgContent,
      },
      { broker }
    );
    broker.emit("budget:exceeded", { profileId: agent.modelModuleId || "default", pausedAgents: [agent.id] }, { channelId });
  }
}
