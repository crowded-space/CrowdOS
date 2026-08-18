import { randomUUID } from "node:crypto";
import { eq, sum } from "drizzle-orm";
import { getDb } from "../config/database.js";
import {
  agents,
  tokenUsageLog,
  workspaceSettings,
  messages,
} from "../../db/schema.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import type { AgentProfile } from "../../Agents/agentGate.js";
import type { ChannelMessage } from "../../Messages/messageGate.js";
import { EscalationChain } from "../../Agents/agentGate.js";

async function getNextSequenceNumber(channelId: string): Promise<number> {
  const db = getDb();
  const lastMessage = await db.query.messages.findFirst({
    where: eq(messages.channelId, channelId),
    orderBy: (table, { desc }) => [desc(table.sequenceNumber)],
  });
  return lastMessage ? lastMessage.sequenceNumber + 1 : 1;
}

export class TokenTracker {
  /**
   * Logs token usage and checks for budget soft cap breaches.
   * Returns true if budget exceeded (agents are paused), false otherwise.
   */
  static async trackUsage(
    broker: EventBroker,
    agent: AgentProfile,
    channelId: string,
    modelModuleId: string | null,
    promptTokens: number,
    completionTokens: number
  ): Promise<boolean> {
    const db = getDb();
    const totalTokens = promptTokens + completionTokens;

    // 1. Insert Usage Log record
    const usageId = `tok-${Date.now()}-${randomUUID().slice(0, 4)}`;
    await db.insert(tokenUsageLog).values({
      id: usageId,
      agentId: agent.id,
      channelId,
      modelModuleId,
      promptTokens,
      completionTokens,
      totalTokens,
      timestamp: new Date(),
    });

    // 2. Fetch Workspace budget settings
    const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) return false;

    const globalSoftCap = settings.globalSoftCap;

    // Calculate sum of total tokens consumed in workspace
    const result = await db.select({
      sum: sum(tokenUsageLog.totalTokens)
    }).from(tokenUsageLog);

    const consumedTokens = parseInt(result[0]?.sum || "0", 10);
    console.log(`[TokenTracker] Consumed tokens: ${consumedTokens} / ${globalSoftCap}`);

    // Emit live usage sync to frontend
    broker.emit("workspace:sync", {}, { channelId });

    // 3. Exceeded check
    if (consumedTokens >= globalSoftCap) {
      console.warn(`[TokenTracker] Global budget soft cap exceeded! consumed ${consumedTokens} >= ${globalSoftCap}`);
      
      // Pause agent & trigger Escalation chain
      await EscalationChain.escalate(
        broker,
        agent,
        channelId,
        "BUDGET_EXCEEDED",
        `Total token budget exceeded workspace soft cap limit of ${globalSoftCap} tokens. Consumed: ${consumedTokens} tokens.`
      );

      return true;
    }

    // 4. Warning checks (80% threshold)
    if (consumedTokens >= globalSoftCap * 0.8) {
      console.warn(`[TokenTracker] Global budget soft cap near capacity (80%+)! consumed ${consumedTokens} / ${globalSoftCap}`);
      
      const nextSeq = await getNextSequenceNumber(channelId);
      const warnMsg: ChannelMessage = {
        id: `msg-warn-budget-${Date.now()}`,
        channelId,
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "stakeholder",
        authorType: "system",
        content: `⚠️ Token usage has reached 80%+ of the workspace budget soft cap (${consumedTokens} / ${globalSoftCap} tokens). Please allocate additional budget to prevent automatic worker standbys.`,
        mentions: [],
        isInternalMonologue: false,
        sequenceNumber: nextSeq,
        timestamp: new Date(),
      };

      await db.insert(messages).values({
        ...warnMsg,
        authorLevel: String(warnMsg.authorLevel),
      });
      broker.emit("message:new", warnMsg, { channelId });
    }

    return false;
  }
}
