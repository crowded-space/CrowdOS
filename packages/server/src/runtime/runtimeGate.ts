import { registerProviders } from "./providers/index.js";
import { RuntimeExecutor, type ExecuteRequest } from "./RuntimeExecutor.js";
import { RuntimeRouter, type RoutingContext } from "./RuntimeRouter.js";
import { ContextAssembler, type AssembleOptions } from "./kernel/ContextAssembler.js";
import { RuntimeKernel } from "./kernel/RuntimeKernel.js";
import { ProviderRegistry } from "./providers/ProviderRegistry.js";
import { GoogleAdapter } from "./providers/GoogleAdapter.js";
import { AnthropicAdapter } from "./providers/AnthropicAdapter.js";
import { OpenAIAdapter } from "./providers/OpenAIAdapter.js";
import { OllamaAdapter } from "./providers/OllamaAdapter.js";
import { CustomAdapter } from "./providers/CustomAdapter.js";
import { ConversationalRuntime } from "./runtimes/ConversationalRuntime.js";
import { AgenticRuntime } from "./runtimes/AgenticRuntime.js";
import { SwarmRuntime } from "./runtimes/SwarmRuntime.js";
import { CodingRuntime } from "./runtimes/CodingRuntime.js";
import { ResearchRuntime } from "./runtimes/ResearchRuntime.js";
import { BaseRuntime } from "./runtimes/BaseRuntime.js";
import { contextPipeline, ContextPipelineManager } from "./kernel/ContextPipelineManager.js";
import { agentCompleteTool, AGENT_COMPLETE, isLifecycleTool } from "./agentControlTools.js";
import type { AgentCompleteInput } from "./agentControlTools.js";
import type {
  ContextPacket,
  RuntimeResult,
  RuntimeEvent,
  RuntimePolicy,
  RuntimeType,
  IRuntime,
  LLMRequest,
  LLMResponse,
  RawToolCall,
  ToolCallRecord,
  ModelModuleConfig,
  IProviderAdapter,
  HistoryMessage,
} from "./types.js";
import type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
  LLMToolDefinition,
} from "./kernel/contextTypes.js";

// Lazy singleton instances for gate ports
let defaultExecutor: RuntimeExecutor | null = null;
let defaultRouter: RuntimeRouter | null = null;
let defaultAssembler: ContextAssembler | null = null;

function getExecutor(): RuntimeExecutor {
  if (!defaultExecutor) defaultExecutor = new RuntimeExecutor();
  return defaultExecutor;
}

function getRouter(): RuntimeRouter {
  if (!defaultRouter) defaultRouter = new RuntimeRouter();
  return defaultRouter;
}

function getAssembler(): ContextAssembler {
  if (!defaultAssembler) defaultAssembler = new ContextAssembler();
  return defaultAssembler;
}

export {
  RuntimeExecutor,
  RuntimeRouter,
  ContextAssembler,
  RuntimeKernel,
  ProviderRegistry,
  GoogleAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  OllamaAdapter,
  CustomAdapter,
  ConversationalRuntime,
  AgenticRuntime,
  SwarmRuntime,
  CodingRuntime,
  ResearchRuntime,
  BaseRuntime,
  contextPipeline,
  ContextPipelineManager,
  agentCompleteTool,
  AGENT_COMPLETE,
  isLifecycleTool,
};

export type {
  ExecuteRequest,
  RoutingContext,
  AssembleOptions,
  ContextPacket,
  RuntimeResult,
  RuntimeEvent,
  RuntimePolicy,
  RuntimeType,
  IRuntime,
  LLMRequest,
  LLMResponse,
  RawToolCall,
  ToolCallRecord,
  ModelModuleConfig,
  IProviderAdapter,
  HistoryMessage,
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
  LLMToolDefinition,
  AgentCompleteInput,
};

export function initRuntime(): void {
  registerProviders();
  console.log("[Runtime] Provider adapters registered.");
}

export const runtimeGate = {
  init: initRuntime,
  execute: (req: ExecuteRequest) => getExecutor().execute(req),
  route: (ctx: RoutingContext) => getRouter().route(ctx),
  assembleContext: (opts: AssembleOptions) => getAssembler().assemble(opts),
  useMiddleware: (middleware: IContextMiddleware) => contextPipeline.use(middleware),
  registerProvider: (adapter: IProviderAdapter) => ProviderRegistry.register(adapter),
  getProvider: (providerName: string) => ProviderRegistry.get(providerName),
  hasProvider: (providerName: string) => ProviderRegistry.has(providerName),
  isLifecycleTool,
  agentCompleteTool,
  invalidateModelModuleCache: (moduleId?: string) => contextPipeline.invalidateModelModuleCache(moduleId),
};
