export {
  contextPipeline,
  ContextPipelineManager,
  ContextAssembler,
  runtimeGate,
} from "./runtime-gate.js";

export type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
  HistoryMessage,
  LLMToolDefinition,
} from "./runtime-gate.js";

export const contextGate = {
  assemble: (ctx: any) => import("./kernel/context-pipeline-manager.js").then(m => m.contextPipeline.assemble(ctx)),
  use: (middleware: any) => import("./kernel/context-pipeline-manager.js").then(m => m.contextPipeline.use(middleware)),
};
