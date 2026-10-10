import { dbScopeKey } from "../../shared/config/database.js";
import { TtlCache } from "../../shared/core/ttl-cache.js";
import { timeAsync } from "../../shared/core/perf-metrics.js";
import { decrypt } from "../../shared/core/secret-box.js";
import { loadRoutingModules, resolveModelModule, routingEnabled, taskClassForRuntime } from "../../shared/core/model-routing.js";
import type { ContextPacket, ModelModuleConfig } from "../types.js";
import type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
} from "./context-types.js";

/**
 * Middlewares at/below this priority are independent of each other (they read
 * disjoint sources and write disjoint packet fields) and run concurrently.
 * Middlewares above it (ContextLimit 75, HistoryCompression 80) consume the
 * assembled history/metadata and stay sequential by design.
 */
const PARALLEL_LANE_MAX_PRIORITY = 70;

// Hot-path cache: model module configs change rarely but were re-read per request.
const modelModuleCache = new TtlCache<ModelModuleConfig>(30_000, 200);

import { IdentityAuthorityMiddleware } from "./middlewares/identity-authority-middleware.js";
import { ChannelAwarenessMiddleware } from "./middlewares/channel-awareness-middleware.js";
import { InstructionStackMiddleware } from "./middlewares/instruction-stack-middleware.js";
import { SkillContextMiddleware } from "./middlewares/skill-context-middleware.js";
import { ToolSchemaMiddleware } from "./middlewares/tool-schema-middleware.js";
import { ConstraintSafetyMiddleware } from "./middlewares/constraint-safety-middleware.js";
import { MemoryRetrievalMiddleware } from "./middlewares/memory-retrieval-middleware.js";
import { VisibilityMatrixMiddleware } from "./middlewares/visibility-matrix-middleware.js";
import { ContextLimitMiddleware } from "./middlewares/context-limit-middleware.js";
import { HistoryCompressionMiddleware } from "./middlewares/history-compression-middleware.js";

export class ContextPipelineManager {
  private middlewares: IContextMiddleware[] = [];

  constructor() {
    this.registerDefaultMiddlewares();
  }

  registerDefaultMiddlewares(): void {
    this.middlewares = [
      new ConstraintSafetyMiddleware(),        // 10 — CTX-2 precedence: constraints first
      new InstructionStackMiddleware(),        // 15 — instructions second
      new IdentityAuthorityMiddleware(),       // 20 — persona third (constraints > instructions > persona)
      new ChannelAwarenessMiddleware(),        // 21
      new SkillContextMiddleware(),            // 30
      new ToolSchemaMiddleware(),              // 40
      new MemoryRetrievalMiddleware(),         // 60
      new VisibilityMatrixMiddleware(),        // 70
      new HistoryCompressionMiddleware(),      // 80
      new ContextLimitMiddleware(),            // 85 — must run last (accounts for summary block)
    ];
    this.sortMiddlewares();
  }

  use(middleware: IContextMiddleware): this {
    this.middlewares.push(middleware);
    this.sortMiddlewares();
    return this;
  }

  invalidateModelModuleCache(moduleId?: string): void {
    if (moduleId) modelModuleCache.invalidatePrefix(`${dbScopeKey()}:${moduleId}:`);
    else modelModuleCache.clear();
  }

  private sortMiddlewares(): void {
    this.middlewares.sort((a, b) => a.priority - b.priority);
  }

  async assemble(ctx: ContextBuildContext): Promise<ContextPacket & { _modelConfig: ModelModuleConfig }> {
    return timeAsync("context.assemble", () => this._assemble(ctx));
  }

  private async _assemble(ctx: ContextBuildContext): Promise<ContextPacket & { _modelConfig: ModelModuleConfig }> {
    let modelConfig: ModelModuleConfig | null = ctx.modelConfig ?? null;

    if (!ctx.modelConfig && ctx.agent.modelModuleId) {
      const moduleKey = `${dbScopeKey()}:${ctx.agent.modelModuleId}:${ctx.workspaceId}`;
      const cached = modelModuleCache.get(moduleKey);
      if (cached) {
        modelConfig = cached;
      } else {
        // Modules owns model rows: resolve via gate (dynamic import avoids Context↔Modules↔Runtime cycle).
        // C3 local-first: no module rows without a database — default config stands.
        let row: any = null;
        try {
          const { moduleGate } = await import("../../modules/module-gate.js");
          row = await moduleGate.model.get(ctx.agent.modelModuleId, ctx.workspaceId);
        } catch {
          row = null;
        }
        if (row) {
          const envApiKey =
            row.provider === "google" ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) :
            row.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY :
            row.provider === "openai" ? process.env.OPENAI_API_KEY :
            undefined;

          // SEC-4: api_key is stored encrypted at rest; decrypt only here,
          // at the single resolver feeding provider adapters.
          const storedKey = row.apiKey ? decrypt(row.apiKey) : undefined;

          modelConfig = {
            provider: row.provider as any,
            modelName: row.modelName,
            apiKey: storedKey || envApiKey || undefined,
            endpointUrl: row.endpointUrl ?? undefined,
            temperature: row.temperature ?? undefined,
            maxOutputTokens: row.maxOutputTokens ?? undefined,
            topP: row.topP ?? 0.95,
          };
          modelModuleCache.set(moduleKey, modelConfig);
        }
      }
    }

    if (!modelConfig) {
      throw Object.assign(
        new Error(
          ctx.agent.modelModuleId
            ? `Model module not found: ${ctx.agent.modelModuleId} (workspace ${ctx.workspaceId}). Register a provider and bind the agent to it instead of relying on a default.`
            : `Agent ${ctx.agent.name} has no model module. Register a provider and bind the agent to it instead of relying on a default.`,
        ),
        { code: "MODEL_MODULE_NOT_CONFIGURED", statusCode: 400 },
      );
    }

    // MODEL-1: routing decision at the single module resolution point. Chat,
    // planning and coding keep the per-agent pinned module (log-only); the
    // librarian path applies overrides inside its own runtime.
    if (routingEnabled()) {
      try {
        resolveModelModule({
          runtimeType: ctx.runtimeType,
          taskClass: taskClassForRuntime(ctx.runtimeType),
          availableModules: await loadRoutingModules(),
          staticModuleId: ctx.agent.modelModuleId,
          logOnly: true,
        });
      } catch (err) {
        console.error("[ContextPipeline] model.route decision failed:", err);
      }
    }

    const mutablePacket: MutableContextPacket = {
      systemPromptBlocks: [],
      tools: [],
      history: [],
      userPrompt: ctx.userInput,
      policies: {
        // Default per-agent input context cap: 128k tokens.
        maxTokenBudget: 131072,
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

    // Execute middlewares: independent ones concurrently, dependent tail sequentially.
    // Errors are isolated per middleware (logged, skipped) — same semantics as the
    // previous serial loop, one failing stage must not abort assembly.
    const parallelAllowed = process.env.PIPELINE_PARALLEL !== "false";
    const runOne = async (mw: IContextMiddleware): Promise<void> => {
      try {
        await mw.process(mutablePacket, runCtx);
      } catch (err) {
        console.error(`[ContextPipeline] Error in middleware '${mw.name}':`, err);
      }
    };

    if (parallelAllowed) {
      const parallelLane = this.middlewares.filter((mw) => mw.priority <= PARALLEL_LANE_MAX_PRIORITY);
      const serialTail = this.middlewares.filter((mw) => mw.priority > PARALLEL_LANE_MAX_PRIORITY);
      await Promise.all(parallelLane.map(runOne));
      for (const mw of serialTail) {
        await runOne(mw);
      }
    } else {
      for (const mw of this.middlewares) {
        await runOne(mw);
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
        authorId: (h as any).authorId,
        authorType: (h as any).authorType,
        authorLevel: (h as any).authorLevel,
        isSelf: (h as any).isSelf,
        mentions: (h as any).mentions,
        isInternalMonologue: h.isInternalMonologue,
        timestamp: h.timestamp || new Date(),
        toolCalls: h.toolCalls,
        toolCallId: h.toolCallId,
        toolName: h.toolName,
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
