import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import {
  agents,
  channels,
  modelModules,
  instructionModules,
  toolkitModules,
  tools,
  runtimeOverrides,
  messages,
  taskFiles,
  compressedSummaries,
} from "../db/schema.js";
import { formatMessageForAgent } from "./prompt-formatter.js";

export interface BuildPromptInput {
  agentId: string;
  channelId: string;
  currentMessage?: string;
  spawnRequestId?: string; // Optional context for L3
  summarizer?: (messages: any[], previousSummary?: string) => Promise<string>;
  tokenCounter?: (text: string) => number; // Optional custom token counter callback
}

export interface PromptAssemblyResult {
  systemPrompt: string;
  userPrompt: string;
  modelParameters: {
    temperature: number;
    topP: number;
    maxOutputTokens: number;
    stopSequences: string[];
  };
  estimatedTokens: {
    systemPromptTokens: number;
    userPromptTokens: number;
    totalTokens: number;
  };
}

export class MemoryBuilder {
  /**
   * Main pipeline to build the unified system and user prompts for an agent in a channel.
   */
  async buildPrompt(input: BuildPromptInput): Promise<PromptAssemblyResult> {
    const db = getDb();
    // 1. Fetch Agent Identity
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, input.agentId),
    });
    if (!agent) {
      throw new Error(`Agent not found with id: ${input.agentId}`);
    }
    // 2. Fetch Modules
    if (!agent.modelModuleId) {
      throw new Error(`ModelModule not configured for agent: ${agent.id}`);
    }
    const modelModule = await db.query.modelModules.findFirst({
      where: eq(modelModules.id, agent.modelModuleId),
    });
    if (!modelModule) {
      throw new Error(`ModelModule not found with id: ${agent.modelModuleId}`);
    }
    const instructionModule = await db.query.instructionModules.findFirst({
      where: eq(instructionModules.id, agent.instructionModuleId),
    });
    if (!instructionModule) {
      throw new Error(`InstructionModule not found with id: ${agent.instructionModuleId}`);
    }
    let allowedToolsList: any[] = [];
    if (agent.toolkitModuleId) {
      const toolkitModule = await db.query.toolkitModules.findFirst({
        where: eq(toolkitModules.id, agent.toolkitModuleId),
      });
      if (toolkitModule && toolkitModule.tools.length > 0) {
        allowedToolsList = await db.query.tools.findMany({
          where: inArray(tools.id, toolkitModule.tools),
        });
      }
    }
    // 3. System Prompt & Overrides Assembly [1] & [1b]
    const baseSystemPrompt = instructionModule.base.join("\n");
    const activeOverrides = await db.query.runtimeOverrides.findMany({
      where: and(
        eq(runtimeOverrides.targetAgentId, agent.id),
        or(isNull(runtimeOverrides.expiresAt), gt(runtimeOverrides.expiresAt, new Date())),
      ),
    });
    let overrideInstructions = baseSystemPrompt;
    const appendPatches: string[] = [];
    for (const override of activeOverrides) {
      if (override.instructionPatch) {
        if (override.instructionPatch.replace && override.instructionPatch.replace.length > 0) {
          overrideInstructions = override.instructionPatch.replace.join("\n");
        }
        if (override.instructionPatch.append && override.instructionPatch.append.length > 0) {
          appendPatches.push(override.instructionPatch.append.join("\n"));
        }
      }
    }
    let systemPrompt = overrideInstructions;
    if (appendPatches.length > 0) {
      systemPrompt += `\n\n[RUNTIME OVERRIDE PATCH]\n${appendPatches.join("\n---\n")}`;
    }
    // 4. Authority Context Assembly [2]
    const authorityContext = await this.compileAuthorityContext(agent, input.channelId);
    // 5. Available Tools Schema [3]
    let toolsContext = "";
    if (allowedToolsList.length > 0) {
      toolsContext =
        `<available_tools>\n` +
        allowedToolsList
          .map(
            (t) =>
              `- Tool: ${t.name}\n  Description: ${t.description}\n  Schema: ${JSON.stringify(t.jsonSchema)}`,
          )
          .join("\n\n") +
        `\n</available_tools>`;
    }
    // 6. Task File (L3 Pinned Content) [4]
    let taskFileContext = "";
    if (agent.authorityLevel === 3) {
      const taskFile = await db.query.taskFiles.findFirst({
        where: or(eq(taskFiles.workerAgentId, agent.id), eq(taskFiles.supervisorAgentId, agent.id)),
        orderBy: (table: any, { desc }: any) => [desc(table.createdAt)],
      });
      if (taskFile) {
        taskFileContext = `<task_file title="${escapeXmlAttr(taskFile.title)}">\n${taskFile.content}\n</task_file>`;
      }
    }
    // 7. Shared Memory (History Processing with 3-Tier token compression) [4/5]
    let sharedMemoryContext = "";
    if (
      agent.authorityLevel !== 3 ||
      (agent.authorityLevel === 3 && (await this.isPairPrivateChannel(input.channelId)))
    ) {
      sharedMemoryContext = await this.buildSharedMemory(
        agent,
        input.channelId,
        modelModule,
        input.summarizer,
        input.currentMessage,
      );
    }
    // 8. Independent Memory (Self-Scratchpad / Monologue logs) [5/6]
    let independentMemoryContext = "";
    if (agent.authorityLevel !== 3 || agent.l3Subtype === "supervisor") {
      independentMemoryContext = await this.buildIndependentMemory(agent.id, input.channelId);
    }
    // 9. Current Message [6/7]
    let currentMessageContext = "";
    if (input.currentMessage) {
      currentMessageContext = `<current_message>\n${input.currentMessage}\n</current_message>`;
    }
    // 10. Stitch together User Prompt according to Authority Level Canonical Order
    let userPromptParts: string[] = [];
    if (agent.authorityLevel === 1) {
      // L1 CEO: AuthContext -> Tools -> SharedMemory -> IndependentMemory -> CurrentMsg
      userPromptParts = [
        authorityContext,
        toolsContext,
        sharedMemoryContext,
        independentMemoryContext,
        currentMessageContext,
      ];
    } else if (agent.authorityLevel === 2) {
      // L2 Manager: AuthContext -> Tools -> SharedMemory -> IndependentMemory -> CurrentMsg
      userPromptParts = [
        authorityContext,
        toolsContext,
        sharedMemoryContext,
        independentMemoryContext,
        currentMessageContext,
      ];
    } else if (agent.authorityLevel === 3 && agent.l3Subtype === "worker") {
      // L3 Worker: AuthContext -> Tools -> TaskFile -> SharedMemory -> CurrentMsg
      userPromptParts = [
        authorityContext,
        toolsContext,
        taskFileContext,
        sharedMemoryContext,
        currentMessageContext,
      ];
    } else if (agent.authorityLevel === 3 && agent.l3Subtype === "supervisor") {
      // L3 Supervisor: AuthContext -> Tools -> TaskFile -> SharedMemory -> IndependentMemory -> CurrentMsg
      userPromptParts = [
        authorityContext,
        toolsContext,
        taskFileContext,
        sharedMemoryContext,
        independentMemoryContext,
        currentMessageContext,
      ];
    } else {
      // Fallback
      userPromptParts = [
        authorityContext,
        toolsContext,
        sharedMemoryContext,
        independentMemoryContext,
        currentMessageContext,
      ];
    }
    const userPrompt = userPromptParts.filter((p) => p.trim().length > 0).join("\n\n");
    const counter = input.tokenCounter ?? ((text: string) => Math.ceil(text.length / 4));
    const systemPromptTokens = counter(systemPrompt);
    const userPromptTokens = counter(userPrompt);
    const totalTokens = systemPromptTokens + userPromptTokens;
    return {
      systemPrompt,
      userPrompt,
      modelParameters: {
        temperature: modelModule.temperature,
        topP: modelModule.topP,
        maxOutputTokens: modelModule.maxOutputTokens,
        stopSequences: modelModule.stopSequences,
      },
      estimatedTokens: {
        systemPromptTokens,
        userPromptTokens,
        totalTokens,
      },
    };
  }

  /**
   * Determine if a channel is a pair_private (L3 worker-supervisor) channel.
   */
  async isPairPrivateChannel(channelId: string): Promise<boolean> {
    const db = getDb();
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    return channel?.type === "pair_private";
  }

  /**
   * Compiles the Authority Context block depending on the agent tier.
   */
  async compileAuthorityContext(agent: any, channelId: string): Promise<string> {
    const db = getDb();
    const activeChannel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    const channelName = activeChannel?.name ?? "unknown-channel";
    if (agent.authorityLevel === 1) {
      // L1 CEO Context
      const l2Agents = await db.query.agents.findMany({
        where: eq(agents.authorityLevel, 2),
      });
      const l2List = l2Agents
        .map((a, idx) => `${idx + 1}. Name: "${a.name}" (Title: ${a.title})`)
        .join("\n");
      return `<authority_context>
Kamu adalah Level 1 CEO Agent.
Kamu memiliki akses ke Bipolar Dispatch Function.
Berikut daftar agen L2 yang tersedia:
${l2List || "Tidak ada L2 Manager yang terdaftar."}
</authority_context>`;
    }
    if (agent.authorityLevel === 2) {
      // L2 Manager Context
      const l1Agents = await db.query.agents.findMany({
        where: eq(agents.authorityLevel, 1),
      });
      const l1Names = l1Agents.map((a) => `"${a.name}"`).join(", ") || "CEO";
      return `<authority_context>
Kamu adalah Level 2 Manager. Atasanmu adalah L1: ${l1Names}.
Kamu bekerja di channel #${channelName}.
Kamu bisa men-dispatch L3 Worker/Supervisor.
</authority_context>`;
    }
    if (agent.authorityLevel === 3) {
      // L3 Workers & Supervisors Context from task association
      const taskFile = await db.query.taskFiles.findFirst({
        where: or(eq(taskFiles.workerAgentId, agent.id), eq(taskFiles.supervisorAgentId, agent.id)),
      });
      if (agent.l3Subtype === "worker") {
        let supervisorName = "Supervisor";
        if (taskFile) {
          const supervisor = await db.query.agents.findFirst({
            where: eq(agents.id, taskFile.supervisorAgentId),
          });
          if (supervisor) supervisorName = supervisor.name;
        }
        return `<authority_context>
Kamu adalah Level 3 Worker.
Supervisormu adalah "${supervisorName}".
Fokus pada tugas yang diberikan. Jangan mengambil keputusan arsitektur.
</authority_context>`;
      }
      if (agent.l3Subtype === "supervisor") {
        let workerName = "Worker";
        if (taskFile) {
          const worker = await db.query.agents.findFirst({
            where: eq(agents.id, taskFile.workerAgentId),
          });
          if (worker) workerName = worker.name;
        }
        return `<authority_context>
Kamu adalah Level 3 Supervisor.
Worker pendampingmu: "${workerName}".
Tugasmu: evaluasi output, jaga konteks, dan eskalasi jika gagal.
</authority_context>`;
      }
    }
    return `<authority_context>
Kamu adalah agen di multi-agent workspace CrowdOS.
Authority Level: ${agent.authorityLevel}
</authority_context>`;
  }

  /**
   * Fetches, filters, compresses, and compiles Shared Memory message tags.
   */
  async buildSharedMemory(
    agent: any,
    channelId: string,
    modelModule: any,
    customSummarizer?: (messages: any[], previousSummary?: string) => Promise<string>,
    currentMessage?: string,
  ): Promise<string> {
    const db = getDb();
    // 1. Fetch latest raw public messages in this channel (capped SQL-side; newest-first then reverse to ascending)
    const latestDesc = await db.query.messages.findMany({
      where: and(eq(messages.channelId, channelId), eq(messages.isInternalMonologue, false)),
      orderBy: (table: any, { desc }: any) => [desc(table.sequenceNumber)],
      limit: 200,
    });
    const allMessages = [...latestDesc].reverse();
    if (allMessages.length === 0) {
      return "";
    }
    let filteredMessages = allMessages;
    if (currentMessage && allMessages.length > 0) {
      const lastMsg = allMessages[allMessages.length - 1];
      if (lastMsg.authorType === "user" && lastMsg.content === currentMessage) {
        filteredMessages = allMessages.slice(0, -1);
      }
    }
    // 2. Enforce Visibility Matrix filtering
    const visibleMessages = filteredMessages.filter((msg: any) => this.evaluateVisibility(msg, agent));
    if (visibleMessages.length === 0) {
      return "";
    }
    // 3. Compression / Sliding Window Pipeline (3-Tier)
    let finalSummaryText = "";
    let displayMessages = visibleMessages;
    if (modelModule.enableCompression && visibleMessages.length > modelModule.compressionThreshold) {
      const compressLimitSeq = visibleMessages.length - modelModule.maxRecentMessages;
      if (compressLimitSeq > 0) {
        // Find last sequence number to compress
        const lastCompressMsg = visibleMessages[compressLimitSeq - 1];
        const lastCompressSeq = lastCompressMsg.sequenceNumber;
        // Fetch or update cached summary
        finalSummaryText = await this.getOrUpdateSummary(
          channelId,
          lastCompressSeq,
          visibleMessages.slice(0, compressLimitSeq),
          customSummarizer,
        );
        // Raw messages only include those above the compressed sequence
        displayMessages = visibleMessages.filter((msg: any) => msg.sequenceNumber > lastCompressSeq);
      }
    }
    // 4. Format XML structures
    const formattedMessages = displayMessages
      .map((msg: any) => formatMessageForAgent(msg, agent.name))
      .join("\n\n");
    let headerLabel = `[Shared Channel: #${await this.getChannelName(channelId)}]`;
    // For L2 dual-chatroom separation, label clearly
    if (agent.authorityLevel === 2) {
      const isL3 = await this.isPairPrivateChannel(channelId);
      headerLabel = isL3
        ? `[Shared Memory: Channel dengan L3 Workers]`
        : `[Shared Memory: Channel dengan L1 & Users]`;
    }
    let summaryBlock = "";
    if (finalSummaryText) {
      summaryBlock = `<channel_summary>\n${finalSummaryText}\n</channel_summary>\n\n`;
    }
    return `${headerLabel}\n\n${summaryBlock}${formattedMessages}`;
  }

  /**
   * Helper to look up channel name.
   */
  async getChannelName(channelId: string): Promise<string> {
    const db = getDb();
    const ch = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    return ch?.name ?? "unknown";
  }

  /**
   * Evaluates the Visibility Matrix rules for a single message.
   */
  evaluateVisibility(msg: any, agent: any): boolean {
    // Mentions always trump all other visibility policies
    const isMentioned = msg.mentions?.some(
      (m: any) =>
        m.targetId === agent.id ||
        m.targetName.toLowerCase() === agent.name.toLowerCase() ||
        m.targetName.toLowerCase() === `@${agent.name.toLowerCase()}`,
    );
    if (isMentioned) {
      return true;
    }
    if (agent.memorySharingPolicy === "none") {
      return false;
    }
    if (agent.memorySharingPolicy === "full") {
      return true;
    }
    // System messages are crucial for all
    if (msg.authorType === "system") {
      return true;
    }
    // Users (Stakeholders) are visible to L1 and L2
    if (msg.authorType === "user" || msg.authorLevel === "stakeholder") {
      return agent.authorityLevel === 1 || agent.authorityLevel === 2;
    }
    const msgLevel = parseInt(msg.authorLevel, 10);
    if (isNaN(msgLevel)) {
      return false;
    }
    if (agent.memorySharingPolicy === "horizontal") {
      return msgLevel === agent.authorityLevel;
    }
    if (agent.memorySharingPolicy === "vertical") {
      return Math.abs(msgLevel - agent.authorityLevel) === 1;
    }
    return false;
  }

  /**
   * Summary compression engine with database caching.
   */
  async getOrUpdateSummary(
    channelId: string,
    upToSeq: number,
    messagesToCompress: any[],
    customSummarizer?: (messages: any[], previousSummary?: string) => Promise<string>,
  ): Promise<string> {
    const db = getDb();
    // Query existing summaries
    const cached = await db.query.compressedSummaries.findFirst({
      where: eq(compressedSummaries.channelId, channelId),
      orderBy: (table: any, { desc }: any) => [desc(table.coversUpToSeq)],
    });
    if (cached) {
      if (cached.coversUpToSeq >= upToSeq) {
        return cached.summary;
      }
      // Increment summary with new messages
      const newMessages = messagesToCompress.filter((m: any) => m.sequenceNumber > cached.coversUpToSeq);
      if (newMessages.length === 0) {
        return cached.summary;
      }
      const updatedText = customSummarizer
        ? await customSummarizer(newMessages, cached.summary)
        : this.defaultNaiveSummary(newMessages, cached.summary);
      await db.insert(compressedSummaries).values({
        id: randomUUID(),
        channelId,
        summary: updatedText,
        coversUpToSeq: upToSeq,
        createdAt: new Date(),
      });
      return updatedText;
    }
    // Generate brand new summary
    const brandNewText = customSummarizer
      ? await customSummarizer(messagesToCompress)
      : this.defaultNaiveSummary(messagesToCompress);
    await db.insert(compressedSummaries).values({
      id: randomUUID(),
      channelId,
      summary: brandNewText,
      coversUpToSeq: upToSeq,
      createdAt: new Date(),
    });
    return brandNewText;
  }

  /**
   * Dynamic fallback summarization helper.
   */
  defaultNaiveSummary(messagesToCompress: any[], prevSummary = ""): string {
    const authors = messagesToCompress
      .map((m) => m.authorName)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");
    let summary = `[Compressed history. Topics discussed by: ${authors || "unknown"}.]`;
    if (prevSummary) {
      summary = `${prevSummary}\n[Continued: Discussion updates from ${authors || "unknown"}.]`;
    }
    return summary;
  }

  /**
   * Compiles Independent Memory (Self-Scratchpad / Monologue).
   */
  async buildIndependentMemory(agentId: string, channelId: string): Promise<string> {
    const db = getDb();
    // Fetch agent monologue messages
    const thoughts = await db.query.messages.findMany({
      where: and(
        eq(messages.channelId, channelId),
        eq(messages.authorId, agentId),
        eq(messages.isInternalMonologue, true),
      ),
      orderBy: (table: any, { asc }: any) => [asc(table.sequenceNumber)],
    });
    if (thoughts.length === 0) {
      return "";
    }
    const formattedThoughts = thoughts
      .map(
        (t: any) =>
          `<internal_thought timestamp="${t.timestamp.toISOString()}">\n${t.content}\n</internal_thought>`,
      )
      .join("\n\n");
    return `[Independent Memory: Self-Scratchpad]\n\n${formattedThoughts}`;
  }
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
