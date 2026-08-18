import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { McpServerConfig, McpServerStatus, McpRawTool } from "./mcpTypes.js";
import type { ToolDefinition, ToolResult, ToolExecutionContext } from "../toolTypes.js";
import { toolRegistry } from "../toolRegistry.js";

interface McpProcessSession {
  config: McpServerConfig;
  process?: ChildProcess;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  lastError?: string;
  tools: Map<string, ToolDefinition>;
  requestId: number;
  pendingRequests: Map<number | string, { resolve: (res: any) => void; reject: (err: Error) => void }>;
  buffer: string;
}

export class McpClientManager extends EventEmitter {
  private sessions: Map<string, McpProcessSession> = new Map();

  async registerServer(config: McpServerConfig): Promise<void> {
    if (this.sessions.has(config.id)) {
      await this.disconnect(config.id);
    }

    const session: McpProcessSession = {
      config,
      status: 'disconnected',
      tools: new Map(),
      requestId: 1,
      pendingRequests: new Map(),
      buffer: "",
    };

    this.sessions.set(config.id, session);

    if (config.autoStart !== false) {
      await this.connect(config.id).catch(err => {
        console.warn(`[MCP] Failed to auto-connect to ${config.id}:`, err.message);
      });
    }
  }

  async connect(serverId: string): Promise<McpServerStatus> {
    const session = this.sessions.get(serverId);
    if (!session) {
      throw new Error(`MCP server '${serverId}' not found`);
    }

    if (session.status === 'connected') {
      return this.getStatus(serverId)!;
    }

    session.status = 'connecting';
    session.lastError = undefined;

    try {
      if (session.config.transport === 'stdio') {
        await this.connectStdio(session);
      } else {
        throw new Error(`Transport '${session.config.transport}' not yet fully implemented in mock/prototype mode`);
      }

      session.status = 'connected';
      return this.getStatus(serverId)!;
    } catch (err: any) {
      session.status = 'error';
      session.lastError = err.message;
      throw err;
    }
  }

  private async connectStdio(session: McpProcessSession): Promise<void> {
    const { command, args = [], envVars = {} } = session.config;
    if (!command) throw new Error(`Command required for stdio transport`);

    const child = spawn(command, args, {
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    session.process = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdioData(session, chunk.toString('utf-8'));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      console.warn(`[MCP:${session.config.id}:stderr]`, chunk.toString('utf-8'));
    });

    child.on('error', (err) => {
      session.status = 'error';
      session.lastError = err.message;
    });

    child.on('exit', () => {
      session.status = 'disconnected';
      this.cleanupTools(session);
    });

    // 1. Send initialize request
    await this.sendJsonRpc(session, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'CrowdOS', version: '2.0.0' },
    });

    // 2. Send initialized notification
    this.sendNotification(session, 'notifications/initialized', {});

    // 3. List tools
    const toolsRes = await this.sendJsonRpc(session, 'tools/list', {});
    const rawTools: McpRawTool[] = toolsRes?.tools || [];

    // 4. Register each tool
    for (const raw of rawTools) {
      const toolDef: ToolDefinition = {
        id: `mcp_${session.config.id}_${raw.name}`,
        name: `mcp_${session.config.id}_${raw.name}`,
        displayName: `${session.config.name}: ${raw.name}`,
        description: raw.description || `MCP Tool from ${session.config.name}`,
        category: 'mcp',
        sourceType: 'mcp',
        sourceId: session.config.id,
        parameters: {
          type: 'object',
          properties: raw.inputSchema?.properties || {},
          required: raw.inputSchema?.required || [],
          additionalProperties: false,
        },
        dangerLevel: 'safe',
        authLevelRequired: 2,
        timeoutMs: 45000,
        handler: async (callArgs: Record<string, any>): Promise<ToolResult> => {
          const startTime = Date.now();
          try {
            const callRes = await this.sendJsonRpc(session, 'tools/call', {
              name: raw.name,
              arguments: callArgs,
            });
            const textOutputs: string[] = [];
            if (Array.isArray(callRes?.content)) {
              for (const c of callRes.content) {
                if (c.type === 'text') textOutputs.push(c.text);
                else textOutputs.push(JSON.stringify(c));
              }
            }
            return {
              success: !callRes?.isError,
              output: textOutputs.join('\n') || JSON.stringify(callRes),
              durationMs: Date.now() - startTime,
            };
          } catch (err: any) {
            return {
              success: false,
              output: '',
              error: err.message,
              durationMs: Date.now() - startTime,
            };
          }
        },
      };

      session.tools.set(toolDef.id, toolDef);
      toolRegistry.register(toolDef);
    }
  }

  private handleStdioData(session: McpProcessSession, text: string): void {
    session.buffer += text;
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && session.pendingRequests.has(msg.id)) {
          const { resolve, reject } = session.pendingRequests.get(msg.id)!;
          session.pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Line might be partial or non-JSON log
      }
    }
  }

  private sendJsonRpc(session: McpProcessSession, method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!session.process || !session.process.stdin) {
        return reject(new Error(`MCP server process not running`));
      }
      const id = session.requestId++;
      const timeout = setTimeout(() => {
        session.pendingRequests.delete(id);
        reject(new Error(`MCP Request timed out for method '${method}'`));
      }, 30000);

      session.pendingRequests.set(id, {
        resolve: (res) => {
          clearTimeout(timeout);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      session.process.stdin.write(payload);
    });
  }

  private sendNotification(session: McpProcessSession, method: string, params: any): void {
    if (!session.process || !session.process.stdin) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    session.process.stdin.write(payload);
  }

  private cleanupTools(session: McpProcessSession): void {
    for (const [toolId] of session.tools) {
      toolRegistry.unregister(toolId);
    }
    session.tools.clear();
  }

  async disconnect(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;

    this.cleanupTools(session);

    if (session.process) {
      try {
        session.process.kill();
      } catch {}
      session.process = undefined;
    }
    session.status = 'disconnected';
  }

  getStatus(serverId: string): McpServerStatus | null {
    const session = this.sessions.get(serverId);
    if (!session) return null;
    return {
      id: session.config.id,
      name: session.config.name,
      status: session.status,
      lastError: session.lastError,
      toolCount: session.tools.size,
      tools: Array.from(session.tools.keys()),
    };
  }

  listStatuses(): McpServerStatus[] {
    return Array.from(this.sessions.keys()).map(id => this.getStatus(id)!);
  }
}

export const mcpClientManager = new McpClientManager();
