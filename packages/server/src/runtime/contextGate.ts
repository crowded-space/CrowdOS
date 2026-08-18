export { contextPipeline, ContextPipelineManager } from "./kernel/ContextPipelineManager.js";
export { ContextAssembler } from "./kernel/ContextAssembler.js";
export type {
  ContextBuildContext,
  MutableContextPacket,
  IContextMiddleware,
  HistoryMessage,
  LLMToolDefinition,
} from "./kernel/contextTypes.js";

export const contextGate = {
  assemble: (ctx: any) => import("./kernel/ContextPipelineManager.js").then(m => m.contextPipeline.assemble(ctx)),
  use: (middleware: any) => import("./kernel/ContextPipelineManager.js").then(m => m.contextPipeline.use(middleware)),
};
