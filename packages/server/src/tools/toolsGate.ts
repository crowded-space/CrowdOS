import { ToolExecutor } from "./ToolExecutor.js";
import { toolRegistry, activeSchedules } from "./toolRegistry.js";
import { mcpClientManager } from "./mcp/mcpClientManager.js";
import { Guard } from "./safety/Guard.js";

export { ToolExecutor } from "./ToolExecutor.js";
export { toolRegistry, activeSchedules } from "./toolRegistry.js";
export { mcpClientManager } from "./mcp/mcpClientManager.js";
export { Guard } from "./safety/Guard.js";
export { ToolTimeoutError } from "./toolTypes.js";
export type {
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
  ToolParameterSchema,
  ToolSourceType,
  ToolDangerLevel,
} from "./toolTypes.js";
export type {
  McpServerConfig,
  McpServerStatus,
  McpRawTool,
  McpTransport,
  McpFraming,
} from "./mcp/mcpTypes.js";

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
