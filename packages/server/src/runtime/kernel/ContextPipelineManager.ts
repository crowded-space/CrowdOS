import { eq } from "drizzle-orm";
import { getDb } from "../../Shared/config/database.js";
import { modelModules } from "../../db/schema.js";
import type { ContextPacket, ModelModuleConfig } from "../types.js";
import type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
} from "./contextTypes.js";

import { IdentityAuthorityMiddleware } from "./middlewares/IdentityAuthorityMiddleware.js";
import { InstructionStackMiddleware } from "./middlewares/InstructionStackMiddleware.js";
import { SkillContextMiddleware } from "./middlewares/SkillContextMiddleware.js";
import { ToolSchemaMiddleware } from "./middlewares/ToolSchemaMiddleware.js";
import { ConstraintSafetyMiddleware } from "./middlewares/ConstraintSafetyMiddleware.js";
import { MemoryRetrievalMiddleware } from "./middlewares/MemoryRetrievalMiddleware.js";
import { VisibilityMatrixMiddleware } from "./middlewares/VisibilityMatrixMiddleware.js";
import { HistoryCompressionMiddleware } from "./middlewares/HistoryCompressionMiddleware.js";

export class ContextPipelineManager {
  private middlewares: IContextMiddleware[] = [];

  constructor() {
    this.registerDefaultMiddlewares();
  }

  registerDefaultMiddlewares(): void {
    this.middlewares = [
      new IdentityAuthorityMiddleware(),
      new InstructionStackMiddleware(),
      new SkillContextMiddleware(),
      new ToolSchemaMiddleware(),
      new ConstraintSafetyMiddleware(),
      new MemoryRetrievalMiddleware(),
      new VisibilityMatrixMiddleware(),
      new HistoryCompressionMiddleware(),
    ];
    this.sortMiddlewares();
  }

  use(middleware: IContextMiddleware): this {
    this.middlewares.push(middleware);
    this.sortMiddlewares();
    return this;
  }

  private sortMiddlewares(): void {
    this.middlewares.sort((a, b) => a.priority - b.priority);
  }

  async assemble(ctx: ContextBuildContext): Promise<ContextPacket & { _modelConfig: ModelModuleConfig }> {
    const db = getDb();
    let modelConfig: ModelModuleConfig = ctx.modelConfig || {
      provider: "google",
      modelName: "gemini-2.0-flash",
      temperature: 0.7,
      maxOutputTokens: 2048,
      topP: 0.95,
    };

    if (!ctx.modelConfig && ctx.agent.modelModuleId) {
      const row = await db.query.modelModules.findFirst({
        where: eq(modelModules.id, ctx.agent.modelModuleId),
      });
      if (row) {
        modelConfig = {
          provider: row.provider as any,
          modelName: row.modelName,
          apiKey: row.apiKey ?? undefined,
          endpointUrl: row.endpointUrl ?? undefined,
          temperature: row.temperature,
          maxOutputTokens: row.maxOutputTokens,
          topP: row.topP ?? 0.95,
        };
      }
    }

    const mutablePacket: MutableContextPacket = {
      systemPromptBlocks: [],
      tools: [],
      history: [],
      userPrompt: ctx.userInput,
      policies: {
        maxTokenBudget: 8000,
        maxIterations: 10,
        allowToolCalls: true,
        allowSpawn: false,
        allowDelegation: false,
        loopDetection: true,
        streamOutput: true,
      },
      metadata: {},
    };

    const runCtx: ContextBuildContext = {
      ...ctx,
      modelConfig,
    };

    // Execute each middleware in priority order
    for (const mw of this.middlewares) {
      try {
        await mw.process(mutablePacket, runCtx);
      } catch (err) {
        console.error(`[ContextPipeline] Error in middleware '${mw.name}':`, err);
      }
    }

    // Sort system prompt blocks by priority
    mutablePacket.systemPromptBlocks.sort((a, b) => a.priority - b.priority);
    const combinedSystemPrompt = mutablePacket.systemPromptBlocks.map(b => b.content).join("\n\n");

    const finalPacket: ContextPacket & { _modelConfig: ModelModuleConfig } = {
      requestId: "ctx_" + Date.now(),
      agentId: ctx.agent.id,
      agentName: ctx.agent.name,
      authorityLevel: ctx.agent.authorityLevel,
      channelId: ctx.channelId,
      workspaceId: ctx.workspaceId,
      userInput: mutablePacket.userPrompt,
      systemPrompt: combinedSystemPrompt,
      history: mutablePacket.history.map(h => ({
        role: h.role,
        content: h.content,
        authorName: h.authorName,
        isInternalMonologue: h.isInternalMonologue,
        timestamp: h.timestamp || new Date(),
      })),
      tools: mutablePacket.tools,
      memoryPreviewBlock: mutablePacket.memoryPreviewBlock,
      policies: mutablePacket.policies,
      metadata: {
        runtimeType: ctx.runtimeType,
        provider: modelConfig.provider,
        modelName: modelConfig.modelName,
        modelModuleId: ctx.agent.modelModuleId || "default",
        startedAt: new Date(),
      },
      _modelConfig: modelConfig,
    };

    return finalPacket;
  }
}

export const contextPipeline = new ContextPipelineManager();
