import type { AgentTool } from '@crowdos/pi-core';
import { readFile, editFile, writeFile, executeBash } from '@crowdos/pi-core';
import { Guard, toolsGate } from '../../tools/toolsGate.js';
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js';

export interface PiToolBridgeContext {
  agentId: string;
  channelId: string;
  workspaceId: string;
  authorityLevel: number;
  broker: EventBroker;
}

export class PiToolBridge {
  static createCodingTools(ctx: PiToolBridgeContext): AgentTool[] {
    const { agentId, channelId, workspaceId, broker } = ctx;

    const readTool: AgentTool = {
      name: 'read_file',
      description: 'Read the contents of a file with line numbers and optional line range bounding.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path to read.' },
          startLine: { type: 'number', description: 'Starting line number (1-based, inclusive).' },
          endLine: { type: 'number', description: 'Ending line number (1-based, inclusive).' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const filePath = String(args.path);
        const validPath = Guard.validatePath(filePath);

        const result = await readFile({
          path: validPath,
          startLine: args.startLine ? Number(args.startLine) : undefined,
          endLine: args.endLine ? Number(args.endLine) : undefined,
        });

        if (!result.success) {
          return { success: false, output: '', error: result.error };
        }

        return {
          success: true,
          output: result.content,
        };
      },
    };

    const editTool: AgentTool = {
      name: 'edit_file',
      description: 'Perform a precision search-and-replace edit on an existing file and generate a unified diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          targetContent: { type: 'string', description: 'Exact string or lines of code to replace.' },
          replacementContent: { type: 'string', description: 'Replacement content.' },
          startLine: { type: 'number', description: 'Optional start line bound.' },
          endLine: { type: 'number', description: 'Optional end line bound.' },
          allowMultiple: { type: 'boolean', description: 'Replace all occurrences if true.' },
        },
        required: ['path', 'targetContent', 'replacementContent'],
      },
      execute: async (args) => {
        const filePath = String(args.path);
        const validPath = Guard.validatePath(filePath);

        const result = await editFile({
          path: validPath,
          targetContent: String(args.targetContent),
          replacementContent: String(args.replacementContent),
          startLine: args.startLine ? Number(args.startLine) : undefined,
          endLine: args.endLine ? Number(args.endLine) : undefined,
          allowMultiple: Boolean(args.allowMultiple),
        });

        if (!result.success) {
          return { success: false, output: '', error: result.error };
        }

        broker.emit('sandbox:updated', {
          sandboxId: workspaceId,
          workspaceId,
          path: validPath,
          changeType: 'write',
          timestamp: new Date().toISOString(),
        });

        return {
          success: true,
          output: `File edited successfully (${result.occurrencesReplaced} occurrence(s) replaced).\nDiff:\n${result.diff}`,
        };
      },
    };

    const writeTool: AgentTool = {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to create or write.' },
          content: { type: 'string', description: 'Complete file text content.' },
          overwrite: { type: 'boolean', description: 'Allow overwriting if file already exists.' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        const filePath = String(args.path);
        const validPath = Guard.validatePath(filePath);

        const result = await writeFile({
          path: validPath,
          content: String(args.content),
          overwrite: args.overwrite !== undefined ? Boolean(args.overwrite) : true,
        });

        if (!result.success) {
          return { success: false, output: '', error: result.error };
        }

        broker.emit('sandbox:updated', {
          sandboxId: workspaceId,
          workspaceId,
          path: validPath,
          changeType: 'write',
          timestamp: new Date().toISOString(),
        });

        return {
          success: true,
          output: `File ${filePath} written successfully (${result.bytesWritten} bytes).`,
        };
      },
    };

    const bashTool: AgentTool = {
      name: 'execute_bash',
      description: 'Execute a shell command or test script within the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to run.' },
          timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (default: 60000).' },
        },
        required: ['command'],
      },
      execute: async (args, signal) => {
        const cmd = String(args.command);
        Guard.validateCommand(cmd);

        const result = await executeBash(
          {
            command: cmd,
            timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 60000,
          },
          process.cwd(),
          signal
        );

        if (!result.success) {
          return {
            success: false,
            output: result.stdout,
            error: result.error || result.stderr || `Command exited with code ${result.exitCode}`,
          };
        }

        return {
          success: true,
          output: result.stdout || '(Command completed with no output)',
        };
      },
    };

    return [readTool, editTool, writeTool, bashTool];
  }

  /**
   * Wrap native / dynamic / MCP tools from toolsGate for the agent into Pi's AgentTool format
   */
  static async createAgentCustomTools(ctx: PiToolBridgeContext): Promise<AgentTool[]> {
    const { agentId, channelId, workspaceId } = ctx;
    const tools = await toolsGate.list();

    const agentTools: AgentTool[] = [];

    for (const tool of tools) {
      // Exclude base coding tools if already provided
      if (['read_file', 'edit_file', 'write_file', 'execute_bash'].includes(tool.name)) {
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
          });

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
