import { registerProviders } from "./providers/index.js";
import { RuntimeExecutor, type ExecuteRequest } from "./runtime-executor.js";
import { RuntimeRouter, type RoutingContext } from "./runtime-router.js";
import { ContextAssembler, type AssembleOptions } from "./kernel/context-assembler.js";
import { RuntimeKernel } from "./kernel/runtime-kernel.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { GoogleAdapter } from "./providers/google-adapter.js";
import { AnthropicAdapter } from "./providers/anthropic-adapter.js";
import { OpenAIAdapter } from "./providers/open-ai-adapter.js";
import { OllamaAdapter } from "./providers/ollama-adapter.js";
import { CustomAdapter } from "./providers/custom-adapter.js";
import { ConversationalRuntime } from "./runtimes/conversational-runtime.js";
import { AgenticRuntime } from "./runtimes/agentic-runtime.js";
import { SwarmRuntime } from "./runtimes/swarm-runtime.js";
import { CodingRuntime } from "./runtimes/coding-runtime.js";
import { ResearchRuntime } from "./runtimes/research-runtime.js";
import { BaseRuntime } from "./runtimes/base-runtime.js";
import { contextPipeline, ContextPipelineManager } from "./kernel/context-pipeline-manager.js";
import { agentCompleteTool, AGENT_COMPLETE, isLifecycleTool } from "./agent-control-tools.js";
import type { AgentCompleteInput } from "./agent-control-tools.js";
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
} from "./kernel/context-types.js";

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
