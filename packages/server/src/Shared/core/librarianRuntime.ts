import { randomUUID } from "node:crypto";
import { eq, and, lte } from "drizzle-orm";
import { getDb } from "../config/database.js";
import {
  agents,
  channels,
  messages,
  modelModules,
  channelIndex,
  compressedSummaries,
  categories,
} from "../../db/schema.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import type { AgentProfile } from "../../Agents/agentGate.js";
import type { ChannelMessage } from "../../Messages/messageGate.js";
import { TokenTracker } from "./tokenTracker.js";
import { LoopArbiter } from "../../core/LoopArbiter.js";
import { compileGoogleEndpoint, isGemmaModel, parseGemmaThoughts } from "./modelRouter.js";

async function getNextSequenceNumber(channelId: string): Promise<number> {
  const db = getDb();
  const lastMessage = await db.query.messages.findFirst({
    where: eq(messages.channelId, channelId),
    orderBy: (table, { desc }) => [desc(table.sequenceNumber)],
  });
  return lastMessage ? lastMessage.sequenceNumber + 1 : 1;
}

export class LibrarianRuntime {
  /**
   * Main execute command called when the Librarian agent is mentioned.
   */
  async execute(broker: EventBroker, channelId: string, librarianAgent: AgentProfile, userMsgContent: string): Promise<void> {
    const db = getDb();

    // 1. Set status to working & thinking
    await db.update(agents).set({ status: "working" }).where(eq(agents.id, librarianAgent.id));
    broker.emit("agent:status", { agentId: librarianAgent.id, status: "working" });
    broker.emit("agent:thinking", { agentId: librarianAgent.id, channelId }, { channelId });

    const contentLower = userMsgContent.toLowerCase();

    // Parse commands: help, index all, index #channel, search "query"
    let replyContent = "";
    
    try {
      if (contentLower.includes("help") || contentLower.includes("status")) {
        replyContent = await this.handleHelpCommand();
      } else if (contentLower.includes("index all") || contentLower.includes("index everything") || contentLower.includes("refresh index")) {
        replyContent = await this.handleIndexAll(broker, librarianAgent, channelId);
      } else if (contentLower.includes("index")) {
        // Try to parse channel name
        const match = userMsgContent.match(/#([\w-]+)/) || userMsgContent.match(/index\s+([\w-]+)/);
        if (match) {
          const channelName = match[1];
          replyContent = await this.handleIndexChannel(broker, librarianAgent, channelId, channelName);
        } else {
          replyContent = `⚠️ Could not parse channel name from your index command. Please specify a channel name, e.g., \`@Librarian index #general-chat\`.`;
        }
      } else if (contentLower.includes("search")) {
        const queryMatch = userMsgContent.match(/search\s+['"]?([^'"]+)['"]?/i);
        if (queryMatch) {
          const query = queryMatch[1];
          replyContent = await this.handleSearchCommand(query);
        } else {
          replyContent = `⚠️ Please specify a search query, e.g., \`@Librarian search "react build"\`.`;
        }
      } else {
        replyContent = `Hello! I am @${librarianAgent.name}, the **Swarm Librarian** 👁️. 
I maintain cross-channel knowledge indices to keep our swarm efficient.

Available commands:
* \`@Librarian help\` / \`status\` — View indexing status.
* \`@Librarian index #channel-name\` — Compile topic summary for a specific channel.
* \`@Librarian index all\` — Re-index all active channels.
* \`@Librarian search "your query"\` — Query cross-channel knowledge records.`;
      }
    } catch (err: any) {
      replyContent = `❌ Librarian execution error: ${err.message || String(err)}`;
    }

    // Stream and save final message
    const streamDelay = 200;
    broker.emit("message:stream", { channelId, agentId: librarianAgent.id, chunk: replyContent }, { channelId });

    setTimeout(async () => {
      const nextSeq = await getNextSequenceNumber(channelId);
      const repMsg: ChannelMessage = {
        id: `msg-${Date.now()}-lib-reply`,
        channelId,
        authorId: librarianAgent.id,
        authorName: librarianAgent.name,
        authorLevel: librarianAgent.authorityLevel as any,
        authorType: "agent",
        content: replyContent,
        mentions: [],
        isInternalMonologue: false,
        sequenceNumber: nextSeq,
        timestamp: new Date(),
      };

      await db.insert(messages).values({
        ...repMsg,
        authorLevel: String(repMsg.authorLevel),
      });
      broker.emit("message:new", repMsg, { channelId });

      // Token Tracking & Loop Check
      const promptTokens = Math.ceil(userMsgContent.length / 4);
      const completionTokens = Math.ceil(repMsg.content.length / 4);
      const budgetExceeded = await TokenTracker.trackUsage(broker, librarianAgent, channelId, librarianAgent.modelModuleId, promptTokens, completionTokens);
      if (!budgetExceeded) {
        await LoopArbiter.checkLoop(broker, librarianAgent, channelId, repMsg.content);
      }

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, librarianAgent.id));
      broker.emit("agent:status", { agentId: librarianAgent.id, status: "idle" });
    }, streamDelay);
  }

  /**
   * Compiles the topic summary index for a single channel.
   */
  async indexChannel(broker: EventBroker, librarianAgent: AgentProfile, targetChannelId: string): Promise<string> {
    const db = getDb();
    
    // 1. Get channel & category
    const chan = await db.query.channels.findFirst({
      where: eq(channels.id, targetChannelId),
    });
    if (!chan) throw new Error(`Channel not found: ${targetChannelId}`);

    let pathName = chan.name;
    if (chan.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, chan.categoryId),
      });
      if (cat) {
        pathName = `${cat.name} / #${chan.name}`;
      }
    } else {
      pathName = `#${chan.name}`;
    }

    // 2. Fetch standard message logs
    const logs = await db.query.messages.findMany({
      where: and(eq(messages.channelId, targetChannelId), eq(messages.isInternalMonologue, false)),
      orderBy: (table, { asc }) => [asc(table.sequenceNumber)],
    });

    if (logs.length === 0) {
      const emptySummary = "Empty sector. No communications logged yet.";
      await this.upsertIndex(targetChannelId, pathName, emptySummary, 0);
      return emptySummary;
    }

    // 3. Compile topic summary via LLM model module
    let summary = "";
    
    const modelModule = librarianAgent.modelModuleId
      ? await db.query.modelModules.findFirst({ where: eq(modelModules.id, librarianAgent.modelModuleId) })
      : null;

    if (modelModule && modelModule.apiKey) {
      try {
        console.log(`[LibrarianRuntime] Calling real Google indexing for #${chan.name}...`);
        const modelName = modelModule.modelName || "gemini-2.0-flash";
        const { url, headers, bodyBuilder } = compileGoogleEndpoint(modelModule);
        
        const historyText = logs.map(m => `[${m.authorName}]: ${m.content}`).join("\n");
        const systemPrompt = "You are the Swarm Librarian. Your task is to compile a high-fidelity summary of discussions, decisions, and action items in this channel history logs. Keep it under 150 words.";

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyBuilder(systemPrompt, `Here are the channel logs:\n${historyText}`)),
        });

        if (response.ok) {
          const json = await response.json();
          let rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          
          if (rawText) {
            if (isGemmaModel(modelName)) {
              const parsed = parseGemmaThoughts(rawText);
              summary = parsed.answer;
            } else {
              summary = rawText;
            }
          }
        }
      } catch (err) {
        console.error("[LibrarianRuntime] Google Indexer call failed:", err);
      }
    }

    // Mock summary fallback if LLM failed or in test environment
    if (!summary) {
      const uniqueAuthors = Array.from(new Set(logs.map(l => l.authorName)));
      const decisionsCount = logs.filter(l => l.content.toLowerCase().includes("approve") || l.content.toLowerCase().includes("completed")).length;
      summary = `Channel #${chan.name} contains ${logs.length} active discussion logs featuring ${uniqueAuthors.join(", ")}. 
Key topics center on workspace development coordination and swarm safety protocols. 
A total of ${decisionsCount} major coordination decisions were compiled in this sector. 
*(Indexed via librarian specialist fallback)*`;
    }

    const lastSeq = logs[logs.length - 1].sequenceNumber;
    await this.upsertIndex(targetChannelId, pathName, summary, lastSeq);

    return summary;
  }

  private async upsertIndex(channelId: string, pathName: string, summary: string, lastSeq: number): Promise<void> {
    const db = getDb();
    
    // Check if index exists
    const [existing] = await db.select().from(channelIndex).where(eq(channelIndex.channelId, channelId)).limit(1);
    
    if (existing) {
      await db.update(channelIndex)
        .set({
          channelPath: pathName,
          topicSummary: summary,
          lastIndexedAt: new Date(),
          messageCountSinceIndex: 0
        })
        .where(eq(channelIndex.channelId, channelId));
    } else {
      await db.insert(channelIndex).values({
        channelId,
        channelPath: pathName,
        topicSummary: summary,
        lastIndexedAt: new Date(),
        messageCountSinceIndex: 0
      });
    }

    // Save history log entry
    await db.insert(compressedSummaries).values({
      id: `sum-${Date.now()}-${randomUUID().slice(0, 4)}`,
      channelId,
      summary,
      coversUpToSeq: lastSeq,
      createdAt: new Date()
    });
  }

  /**
   * Command: help / status
   */
  private async handleHelpCommand(): Promise<string> {
    const db = getDb();
    const indices = await db.select().from(channelIndex);
    
    if (indices.length === 0) {
      return `📊 **Swarm Index Registry Status**: No channels have been compiled yet. Please run \`@Librarian index all\` to start.`;
    }

    let report = `📊 **Swarm Index Registry Status** (${indices.length} sectors compiled):\n\n`;
    report += `| Channel / Sector Path | Last Indexed At | Message Drift |\n`;
    report += `|---|---|---:|\n`;
    indices.forEach(idx => {
      report += `| \`${idx.channelPath}\` | ${new Date(idx.lastIndexedAt).toLocaleTimeString()} | ${idx.messageCountSinceIndex} new |\n`;
    });

    return report;
  }

  /**
   * Command: index all
   */
  private async handleIndexAll(broker: EventBroker, librarianAgent: AgentProfile, originChannelId: string): Promise<string> {
    const db = getDb();
    const allChannels = await db.query.channels.findMany();
    
    console.log(`[LibrarianRuntime] Starting workspace-wide indexing across ${allChannels.length} channels...`);
    
    let report = `📚 **Workspace Indexing Complete!** Compiled summaries for ${allChannels.length} sectors:\n\n`;

    for (const chan of allChannels) {
      try {
        const summary = await this.indexChannel(broker, librarianAgent, chan.id);
        report += `* **${chan.name}**: ${summary.substring(0, 100)}...\n`;
      } catch (err: any) {
        report += `* ❌ **${chan.name}**: Index failed: ${err.message || String(err)}\n`;
      }
    }

    return report;
  }

  /**
   * Command: index #channel
   */
  private async handleIndexChannel(broker: EventBroker, librarianAgent: AgentProfile, originChannelId: string, channelName: string): Promise<string> {
    const db = getDb();
    const chan = await db.query.channels.findFirst({
      where: eq(channels.name, channelName),
    });

    if (!chan) {
      return `⚠️ Channel name \`#${channelName}\` was not resolved in our registry map.`;
    }

    const summary = await this.indexChannel(broker, librarianAgent, chan.id);
    return `📚 **Sector Summary Compiled!** \n\n* **Sector Path**: \`${channelName}\`\n* **Compiled Summary**: \n${summary}`;
  }

  /**
   * Command: search "query"
   */
  private async handleSearchCommand(query: string): Promise<string> {
    const db = getDb();
    const indices = await db.select().from(channelIndex);
    
    const matching = indices.filter(idx => 
      idx.topicSummary.toLowerCase().includes(query.toLowerCase()) || 
      idx.channelPath.toLowerCase().includes(query.toLowerCase())
    );

    if (matching.length === 0) {
      return `🔍 **Search Results for "${query}"**: No matching sectors found.`;
    }

    let report = `🔍 **Search Results for "${query}"** (${matching.length} matching sectors):\n\n`;
    matching.forEach(idx => {
      report += `### 📁 Sector: \`${idx.channelPath}\` \n`;
      report += `* **Last compiled**: ${new Date(idx.lastIndexedAt).toLocaleTimeString()}\n`;
      report += `* **Summary**: ${idx.topicSummary}\n\n`;
    });

    return report;
  }
}
