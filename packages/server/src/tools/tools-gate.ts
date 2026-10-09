import { ToolExecutor } from "./tool-executor.js";
import { toolRegistry, resolveToolRoot } from "./tool-registry.js";
import { mcpClientManager } from "./mcp/mcp-client-manager.js";
import { Guard } from "./safety/guard.js";
import type { ToolDefinition, ToolExecutionContext } from "./tool-types.js";
import type { McpServerConfig } from "./mcp/mcp-types.js";

export { toolRegistry, resolveToolRoot } from "./tool-registry.js";
export { Guard } from "./safety/guard.js";
export type { ToolDefinition } from "./tool-types.js";

/**
 * SK-008: single source of truth for universal tool ids. Consumed by
 * skill-service (resolved tools), tool-executor (fallback), and the
 * tool-schema middleware (context injection) so the three can never drift.
 */
export const UNIVERSAL_TOOL_IDS = [
  "open_memory",
  "discard_memory_from_context",
  "remember",
  "lock_in",
  "lock_out",
  "open_detail",
  "load_skill",
];

export const toolsGate = {
  get: (toolName: string) => toolRegistry.get(toolName),
  has: (toolName: string) => toolRegistry.has(toolName),
  list: (filters?: { category?: string; authLevel?: number }) => toolRegistry.list(filters),
  register: (def: ToolDefinition, opts?: { overwrite?: boolean }) => toolRegistry.register(def, opts),
  unregister: (toolName: string) => toolRegistry.unregister(toolName),
  resolveToolRoot: (ctx?: { channelId?: string; workspaceId?: string }) => resolveToolRoot(ctx),
  execute: (agentId: string, toolId: string, args: Record<string, unknown>, ctx?: Partial<ToolExecutionContext>) =>
    ToolExecutor.execute(agentId, toolId, args, ctx),
  executeBatch: (agentId: string, calls: Array<{ toolId: string; args: Record<string, unknown> }>, ctx?: any) =>
    ToolExecutor.executeBatch(agentId, calls, ctx),
  connectMcp: (serverId: string) => mcpClientManager.connect(serverId),
  disconnectMcp: (serverId: string) => mcpClientManager.disconnect(serverId),
  getMcpStatus: (serverId: string) => mcpClientManager.getStatus(serverId),
  listMcpStatuses: () => mcpClientManager.listStatuses(),
  registerMcpServer: (config: McpServerConfig) => mcpClientManager.registerServer(config),
  unregisterMcpServer: (serverId: string) => mcpClientManager.unregisterServer(serverId),
  // TOLS-05: boot restore — repopulate sessions from mcp_servers.
  restoreMcpServers: () => mcpClientManager.restoreServersFromDb(),
};
