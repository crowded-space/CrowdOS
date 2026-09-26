import { randomUUID } from "node:crypto";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../config/database.js";
import {
  channels,
  messages,
  channelIndex,
  compressedSummaries,
  categories,
} from "../../db/schema.js";
import type { EventBroker } from "../../event-broker/event-broker-gate.js";
import type { AgentProfile } from "../../agents/agent-gate.js";
import { agentGate } from "../../agents/agent-gate.js";
import { moduleGate } from "../../modules/module-gate.js";
import { messageGate } from "../../messages/message-gate.js";
import { TokenTracker } from "./token-tracker.js";
import { LoopArbiter } from "./loop-arbiter.js";
import { compileGoogleEndpoint, isGemmaModel, parseGemmaThoughts } from "./google-model-helpers.js";
import { loadRoutingModules, resolveModelModule } from "./model-routing.js";
import { decrypt as secretBoxDecrypt, isEncrypted } from "./secret-box.js";
import { redactSecrets } from "./redact.js";
import { logMetric } from "./structured-log.js";

const DEGRADED_SUMMARY_PLACEHOLDER = "[INDEX DEGRADED] Summary unavailable — provider call failed.";

export function deltaIndexEnabled(): boolean {
  return (process.env.DELTA_INDEX || "").trim().toLowerCase() !== "false";
}

export interface IndexWindowLog {
  authorName: string;
  content: string;
  sequenceNumber: number;
}

export interface IndexWindow {
  logs: IndexWindowLog[];
  fullWindow: boolean;
}

/**
 * PERF-4: picks the summarizer input window. Delta mode processes only
 * messages past channel_index.last_seq; null last_seq seeds from the full
 * current window once. DELTA_INDEX=false restores the legacy reload-window.
 */
export function selectIndexWindow(
  allLogs: IndexWindowLog[],
  lastIndexedSeq: number | null | undefined,
  deltaMode: boolean
): IndexWindow {
  if (!deltaMode || lastIndexedSeq == null) {
    return { logs: allLogs, fullWindow: true };
  }
  return {
    logs: allLogs.filter((m) => m.sequenceNumber > (lastIndexedSeq as number)),
    fullWindow: false,
  };
}

/**
 * Chars fed to the summarizer this pass — previous summary plus the new
 * messages only (delta), or the raw history on a full window. This length is
 * the −80% input-token proxy measured by the fixture test.
 */
export function compileHistoryText(previousSummary: string, logs: IndexWindowLog[]): string {
  const lines = logs.map((m) => `[${m.authorName}]: ${m.content}`).join("\n");
  if (!previousSummary) return lines;
  return `[PREVIOUS SUMMARY]\n${previousSummary}\n[NEW MESSAGES]\n${lines}`;
}

function redactErrorMessage(message: string): string {
  const scrubbed = message
    .replace(/([?&](?:key|api[_-]?key|access_token|token)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[\w.\-]+/gi, "$1[REDACTED]");
  return String(redactSecrets({ message: scrubbed }).message);
}

export class LibrarianRuntime {
  /**
   * Main execute command called when the Librarian agent is mentioned.
   */
  async execute(broker: EventBroker, channelId: string, librarianAgent: AgentProfile, userMsgContent: string): Promise<void> {
    // 1. Set status to working & thinking (Agents owns the flip)
    await agentGate.setStatus(librarianAgent.id, "working", { broker });
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
      // Messages owns the table: sequence + insert + emit live in messageGate.append.
      const repMsg = await messageGate.append(
        {
          channelId,
          authorId: librarianAgent.id,
          authorName: librarianAgent.name,
          authorLevel: librarianAgent.authorityLevel,
          authorType: "agent",
          content: replyContent,
        },
        { broker }
      );

      // Token Tracking & Loop Check
      const promptTokens = Math.ceil(userMsgContent.length / 4);
      const completionTokens = Math.ceil(repMsg.content.length / 4);
      const budgetExceeded = await TokenTracker.trackUsage(broker, librarianAgent, channelId, librarianAgent.modelModuleId, promptTokens, completionTokens);
      if (!budgetExceeded) {
        await LoopArbiter.checkLoop(broker, librarianAgent, channelId, repMsg.content);
      }

      await agentGate.setStatus(librarianAgent.id, "idle", { broker });
    }, streamDelay);
  }

  /**
   * Compiles the topic summary index for a single channel.
   * PERF-4: delta mode summarizes only messages past channel_index.last_seq,
   * prepending the previous summary; the first run seeds from the full window.
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

    // 2. Current index cursor
    const deltaMode = deltaIndexEnabled();
    const [idxRow] = await db.select().from(channelIndex).where(eq(channelIndex.channelId, targetChannelId)).limit(1);
    const lastIndexedSeq = idxRow?.lastSeq ?? null;

    // 3. Fetch message logs — delta only when a cursor exists
    let logs;
    if (deltaMode && lastIndexedSeq != null) {
      logs = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, targetChannelId),
          eq(messages.isInternalMonologue, false),
          gt(messages.sequenceNumber, lastIndexedSeq),
        ),
        orderBy: (table, { asc }) => [asc(table.sequenceNumber)],
      });
      if (logs.length === 0) {
        return idxRow.topicSummary;
      }
    } else {
      logs = await db.query.messages.findMany({
        where: and(eq(messages.channelId, targetChannelId), eq(messages.isInternalMonologue, false)),
        orderBy: (table, { asc }) => [asc(table.sequenceNumber)],
      });
    }

    if (logs.length === 0) {
      const emptySummary = "Empty sector. No communications logged yet.";
      await this.upsertIndex(targetChannelId, pathName, emptySummary, 0);
      return emptySummary;
    }

    const historyLogs = logs;

    // 4. Compile topic summary via LLM model module (MODEL-1: librarian pinned to flash tier)
    let summary = "";
    let degradeReason = "no_model_configured";

    const routingDecision = resolveModelModule({
      runtimeType: "librarian",
      taskClass: "librarian",
      availableModules: await loadRoutingModules(),
      staticModuleId: librarianAgent.modelModuleId,
      requireCredential: true,
    });
    const routedModuleId = routingDecision.moduleId ?? librarianAgent.modelModuleId ?? null;

    const modelModule = routedModuleId ? await moduleGate.model.get(routedModuleId) : null;

    if (modelModule && modelModule.apiKey) {
      try {
        console.log(`[LibrarianRuntime] Calling real Google indexing for #${chan.name}...`);
        const resolvedModule = modelModule.apiKey && isEncrypted(modelModule.apiKey)
          ? { ...modelModule, apiKey: secretBoxDecrypt(modelModule.apiKey) }
          : modelModule;
        const modelName = resolvedModule.modelName || "gemini-2.0-flash";
        const { url, headers, bodyBuilder } = compileGoogleEndpoint(resolvedModule);

        const historyText = compileHistoryText(
          deltaMode && lastIndexedSeq != null && idxRow ? idxRow.topicSummary : "",
          historyLogs,
        );
        const systemPrompt = "You are the Swarm Librarian. Your task is to compile a high-fidelity summary of discussions, decisions, and action items in this channel history logs. Keep it under 150 words.";

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyBuilder(systemPrompt, `Here are the channel logs:\n${historyText}`)),
          signal: AbortSignal.timeout(15000),
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
          } else {
            degradeReason = "empty_provider_response";
          }
        } else {
          degradeReason = `provider_http_${response.status}`;
        }
      } catch (err) {
        console.error("[LibrarianRuntime] Google Indexer call failed:", err);
        degradeReason = redactErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }

    // DB-3: on failure surface a visible degraded marker — never fabricate content
    if (!summary) {
      await this.markIndexDegraded(broker, targetChannelId, pathName, degradeReason, historyLogs[historyLogs.length - 1].sequenceNumber);
      return `[INDEX DEGRADED] Summary for #${chan.name} unavailable this cycle (${degradeReason}). No synthetic summary was written.`;
    }

    const newLastSeq = historyLogs[historyLogs.length - 1].sequenceNumber;
    await this.upsertIndex(targetChannelId, pathName, summary, Math.max(newLastSeq, lastIndexedSeq ?? 0));

    return summary;
  }

  private async markIndexDegraded(broker: EventBroker, channelId: string, pathName: string, reason: string, lastSeq: number): Promise<void> {
    const db = getDb();
    const now = new Date();

    const [existing] = await db.select().from(channelIndex).where(eq(channelIndex.channelId, channelId)).limit(1);

    if (existing) {
      await db.update(channelIndex)
        .set({
          channelPath: pathName,
          status: "degraded",
          lastError: reason,
          lastIndexedAt: now
        })
        .where(eq(channelIndex.channelId, channelId));
    } else {
      await db.insert(channelIndex).values({
        channelId,
        channelPath: pathName,
        topicSummary: DEGRADED_SUMMARY_PLACEHOLDER,
        lastIndexedAt: now,
        messageCountSinceIndex: 0,
        status: "degraded",
        lastError: reason
      });
    }

    logMetric({ stage: "librarian.index.degraded", channelId, error: reason, failedAtSeq: lastSeq });
    broker.emit("index:degraded", { channelId, path: pathName, reason }, { channelId });
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
          lastSeq,
          messageCountSinceIndex: 0,
          status: "ok",
          lastError: null
        })
        .where(eq(channelIndex.channelId, channelId));
    } else {
      await db.insert(channelIndex).values({
        channelId,
        channelPath: pathName,
        topicSummary: summary,
        lastIndexedAt: new Date(),
        lastSeq,
        messageCountSinceIndex: 0,
        status: "ok",
        lastError: null
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
    // ponytail: explicit columns (no topicSummary blob) for status table
    const indices = await db.select({
      channelId: channelIndex.channelId, channelPath: channelIndex.channelPath,
      lastIndexedAt: channelIndex.lastIndexedAt, messageCountSinceIndex: channelIndex.messageCountSinceIndex,
      status: channelIndex.status, lastError: channelIndex.lastError,
    }).from(channelIndex).limit(500);

    if (indices.length === 0) {
      return `📊 **Swarm Index Registry Status**: No channels have been compiled yet. Please run \`@Librarian index all\` to start.`;
    }

    let report = `📊 **Swarm Index Registry Status** (${indices.length} sectors compiled):\n\n`;
    report += `| Channel / Sector Path | Last Indexed At | Message Drift | Status |\n`;
    report += `|---|---|---:|---|\n`;
    indices.forEach(idx => {
      const statusCell = idx.status === "degraded"
        ? `⚠️ DEGRADED — ${idx.lastError ?? "unknown error"}`
        : "ok";
      report += `| \`${idx.channelPath}\` | ${new Date(idx.lastIndexedAt).toLocaleTimeString()} | ${idx.messageCountSinceIndex} new | ${statusCell} |\n`;
    });

    return report;
  }

  /**
   * Command: index all
   */
  private async handleIndexAll(broker: EventBroker, librarianAgent: AgentProfile, originChannelId: string): Promise<string> {
    const db = getDb();
    const allChannels = await db.query.channels.findMany({
      where: isNull(channels.archivedAt),
    });
    
    console.log(`[LibrarianRuntime] Starting workspace-wide indexing across ${allChannels.length} channels...`);
    
    // ponytail: pool of 3, order-preserving (no new dep)
    let report = `📚 **Workspace Indexing Complete!** Compiled summaries for ${allChannels.length} sectors:\n\n`;
    const parts: string[] = new Array(allChannels.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < allChannels.length) {
        const i = next++;
        const chan = allChannels[i];
        try {
          const summary = await this.indexChannel(broker, librarianAgent, chan.id);
          parts[i] = `* **${chan.name}**: ${summary.substring(0, 100)}...\n`;
        } catch (err: any) {
          parts[i] = `* ❌ **${chan.name}**: Index failed: ${err.message || String(err)}\n`;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, allChannels.length) }, () => worker()),
    );
    report += parts.join("");

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
    // ponytail: explicit columns + truncate topicSummary blob for report
    const indices = await db.select({
      channelId: channelIndex.channelId, channelPath: channelIndex.channelPath,
      topicSummary: sql<string>`substring(${channelIndex.topicSummary} from 1 for 500)`,
      lastIndexedAt: channelIndex.lastIndexedAt, status: channelIndex.status, lastError: channelIndex.lastError,
    }).from(channelIndex).limit(500);
    
    const matching = indices.filter(idx =>
      (idx.topicSummary ?? "").toLowerCase().includes(query.toLowerCase()) ||
      (idx.channelPath ?? "").toLowerCase().includes(query.toLowerCase())
    );

    if (matching.length === 0) {
      return `🔍 **Search Results for "${query}"**: No matching sectors found.`;
    }

    let report = `🔍 **Search Results for "${query}"** (${matching.length} matching sectors):\n\n`;
    matching.forEach(idx => {
      const degraded = idx.status === "degraded";
      report += `### 📁 Sector: \`${idx.channelPath}\`${degraded ? " ⚠️ **DEGRADED INDEX**" : ""} \n`;
      if (degraded) {
        report += `* **Last error**: ${idx.lastError ?? "unknown error"} — summary below is stale, not freshly compiled\n`;
      }
      report += `* **Last compiled**: ${new Date(idx.lastIndexedAt).toLocaleTimeString()}\n`;
      report += `* **Summary**: ${String(idx.topicSummary).substring(0, 500)}\n\n`;
    });

    return report;
  }
}
