export {
  contextPipeline,
  ContextPipelineManager,
  ContextAssembler,
  runtimeGate,
} from "./runtimeGate.js";

export type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
  HistoryMessage,
  LLMToolDefinition,
} from "./runtimeGate.js";

export const contextGate = {
  assemble: (ctx: any) => import("./kernel/ContextPipelineManager.js").then(m => m.contextPipeline.assemble(ctx)),
  use: (middleware: any) => import("./kernel/ContextPipelineManager.js").then(m => m.contextPipeline.use(middleware)),
};
