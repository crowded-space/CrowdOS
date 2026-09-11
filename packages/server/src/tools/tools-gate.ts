import { ToolExecutor } from "./tool-executor.js";
import { toolRegistry, activeSchedules } from "./tool-registry.js";
import { mcpClientManager } from "./mcp/mcp-client-manager.js";
import { Guard } from "./safety/guard.js";

export { ToolExecutor } from "./tool-executor.js";
export { toolRegistry, activeSchedules } from "./tool-registry.js";
export { mcpClientManager } from "./mcp/mcp-client-manager.js";
export { Guard } from "./safety/guard.js";
export { ToolTimeoutError } from "./tool-types.js";
export type {
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
  ToolParameterSchema,
  ToolSourceType,
  ToolDangerLevel,
} from "./tool-types.js";
export type {
  McpServerConfig,
  McpServerStatus,
  McpRawTool,
  McpTransport,
  McpFraming,
} from "./mcp/mcp-types.js";

export const toolsGate = {
  get: (toolName: string) => toolRegistry.get(toolName),
  has: (toolName: string) => toolRegistry.has(toolName),
  list: (filters?: { category?: string; authLevel?: number }) => toolRegistry.list(filters),
  register: (def: any) => toolRegistry.register(def),
  unregister: (toolName: string) => toolRegistry.unregister(toolName),
  execute: (agentId: string, toolId: string, args: any, ctx?: any) => ToolExecutor.execute(agentId, toolId, args, ctx),
  executeBatch: (agentId: string, calls: Array<{ toolId: string; args: Record<string, unknown> }>, ctx?: any) =>
    ToolExecutor.executeBatch(agentId, calls, ctx),
  connectMcp: (serverId: string) => mcpClientManager.connect(serverId),
  disconnectMcp: (serverId: string) => mcpClientManager.disconnect(serverId),
  getMcpStatus: (serverId: string) => mcpClientManager.getStatus(serverId),
  listMcpStatuses: () => mcpClientManager.listStatuses(),
  registerMcpServer: (config: any) => mcpClientManager.registerServer(config),
};
