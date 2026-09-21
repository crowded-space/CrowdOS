import type { AgentTool } from '@crowdspace/pi-core';
import { toolsGate } from '../../tools/tools-gate.js';
import type { EventBroker } from '../../event-broker/event-broker-gate.js';
import { DEFERRED_TOOL_IDS } from '../kernel/middlewares/tool-schema-middleware.js';

export interface PiToolBridgeContext {
  agentId: string;
  channelId: string;
  workspaceId: string;
  authorityLevel: number;
  broker: EventBroker;
  /** RUN-0 correlation for Approvals pause flow (APR-1) */
  runId?: string | null;
  /** Run cancellation signal (CAN-1): forwarded to ToolExecutor so long tools abort with the run. */
  abortSignal?: AbortSignal;
}

export class PiToolBridge {
  static createCodingTools(ctx: PiToolBridgeContext): AgentTool[] {
    const { agentId, channelId, workspaceId, runId, broker } = ctx;

    // All coding tools route through ToolExecutor (via toolsGate): workspace-rooted
    // path sandbox, Guard command policy, agent skill whitelist + authority level,
    // executor timeout with abort-driven process-tree kill (SEC-3).
    // APR-1: runId + broker forwarded so execute_bash ASK can pause WAITING_FOR_APPROVAL.
    const viaExecutor = (
      name: string,
      description: string,
      parameters: AgentTool['parameters']
    ): AgentTool => ({
      name,
      description,
      parameters,
      execute: async (args) => {
        const res = await toolsGate.execute(agentId, name, args ?? {}, {
          channelId,
          workspaceId,
          abortSignal: ctx.abortSignal,
          runId: runId ?? undefined,
          broker,
        } as unknown as Record<string, unknown>);
        return {
          success: res.success,
          output: res.output,
          error: res.error,
        };
      },
    });

    const readTool = viaExecutor('read_file',
      'Read the contents of a file inside your workspace sandbox.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
        },
        required: ['path'],
      });

    const editTool = viaExecutor('edit_file',
      'Perform a precision search-and-replace edit on an existing file in your workspace sandbox.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          targetContent: { type: 'string', description: 'Exact string to replace.' },
          replacementContent: { type: 'string', description: 'Replacement content.' },
          allowMultiple: { type: 'boolean', description: 'Replace all occurrences if true.' },
        },
        required: ['path', 'targetContent', 'replacementContent'],
      });

    const writeTool = viaExecutor('write_file',
      'Create a new file or completely overwrite an existing file inside your workspace sandbox.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Complete file text content.' },
        },
        required: ['path', 'content'],
      });

    const bashTool = viaExecutor('execute_bash',
      'Execute a shell command within the workspace sandbox. Subject to the command safety policy.',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to run.' },
        },
        required: ['command'],
      });

    return [readTool, editTool, writeTool, bashTool];
  }

  /**
   * Wrap native / dynamic / MCP tools from toolsGate for the agent into Pi's AgentTool format
   */
  static async createAgentCustomTools(ctx: PiToolBridgeContext): Promise<AgentTool[]> {
    const { agentId, channelId, workspaceId, runId, broker } = ctx;
    const tools = await toolsGate.list();

    const agentTools: AgentTool[] = [];

    for (const tool of tools) {
      // Exclude base coding tools if already provided
      if (['read_file', 'edit_file', 'write_file', 'execute_bash'].includes(tool.name)) {
        continue;
      }
      // §21 conformance (§23): the Coding Runtime is a deliberate fork, but a
      // fork must not change the tool contract. Every other runtime receives the
      // DEFERRED set through open_detail discovery; injecting the FULL registry
      // here would have given Coding a different, larger tool surface than the
      // rest of the system — exactly the drift §23 calls a defect. The deferred
      // tools stay reachable: open_detail is part of the injected context tools,
      // and the base coding tools above are provided directly by this bridge.
      if (DEFERRED_TOOL_IDS.has(tool.name)) {
        continue;
      }

      agentTools.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as any,
        execute: async (args) => {
          // Auto-thread agentId and channelId for memory tools
          if (tool.name === 'open_memory' || tool.name === 'remember') {
            args = args || {};
            if (!args.agent_id) args.agent_id = agentId;
            if (!args.channel_id) args.channel_id = channelId;
          }

          const res = await toolsGate.execute(agentId, tool.name, args, {
            channelId,
            workspaceId,
            abortSignal: ctx.abortSignal,
            runId: runId ?? undefined,
            broker,
          } as unknown as Record<string, unknown>);

          return {
            success: res.success,
            output: res.output,
            error: res.error,
          };
        },
      });
    }

    return agentTools;
  }
}
