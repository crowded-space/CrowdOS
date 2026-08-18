import { getDb } from "../Shared/config/database.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Guard } from "./safety/Guard.js";
import { toolRegistry } from "./toolRegistry.js";
import { skillService } from "../Skills/skillService.js";
import type { ToolResult, ToolExecutionContext } from "./toolTypes.js";

export class ToolExecutor {
  static async execute(
    agentId: string,
    toolId: string,
    args: any,
    partialCtx?: Partial<ToolExecutionContext>
  ): Promise<ToolResult> {
    const instance = new ToolExecutor();
    return instance.execute(agentId, toolId, args, partialCtx);
  }

  async execute(
    agentId: string,
    toolId: string,
    args: any,
    partialCtx?: Partial<ToolExecutionContext>
  ): Promise<ToolResult> {
    const db = getDb();
    const startTime = Date.now();

    try {
      // 1. Fetch Agent Identity
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });

      if (!agent) {
        throw new Error(`Agent not found with id: ${agentId}`);
      }

      // 2. Authorize Tool (Resolves direct grants + active skill tools + universal tools)
      const allowedTools = await skillService.getResolvedToolsForAgent(agentId);
      const isAllowed = allowedTools.includes(toolId) || 
        ["open_memory", "discard_memory_from_context", "remember"].includes(toolId);

      if (!isAllowed) {
        throw new Error(`Security breach: Tool "${toolId}" is not authorized for @${agent.name}. Please grant it via ToolkitModule or attach a relevant Skill.`);
      }

      // 3. Retrieve tool definition from central registry
      const toolDef = toolRegistry.get(toolId);
      if (!toolDef) {
        throw new Error(`System Error: Tool "${toolId}" not found in central tool registry.`);
      }

      // 4. Enforce authLevelRequired
      if (toolDef.authLevelRequired !== undefined) {
        if (agent.authorityLevel > toolDef.authLevelRequired && !agent.isOmniscient) {
          throw new Error(`Security breach: Tool "${toolId}" requires Level ${toolDef.authLevelRequired} authority. @${agent.name} is Level ${agent.authorityLevel} (Non-Omniscient).`);
        }
      }

      // 5. Run Safety Guards
      if (toolId === "execute_bash") {
        Guard.validateCommand(args.command);
      } else if (toolId === "execute_safe") {
        if (!Guard.isCommandWhitelisted(args.command)) {
          throw new Error(`Safety Alert: Command "${args.command}" is not in the system safe whitelist.`);
        }
      }

      // 6. Build execution context
      const ctx: ToolExecutionContext = {
        agentId,
        channelId: partialCtx?.channelId || "general",
        workspaceId: partialCtx?.workspaceId || "default",
        authorityLevel: agent.authorityLevel,
        abortSignal: partialCtx?.abortSignal,
        logger: partialCtx?.logger || {
          info: (msg, meta) => console.log(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
          warn: (msg, meta) => console.warn(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
          error: (msg, meta) => console.error(`[ToolExecutor:${toolId}]`, msg, meta ?? ""),
        },
      };

      // 7. Execute Tool Handler with Timeout Guard
      const timeoutMs = toolDef.timeoutMs || 30000;
      console.log(`[ToolExecutor] [${agent.name}] Calling tool "${toolId}"...`);

      const executionPromise = toolDef.handler(args, ctx);
      const timeoutPromise = new Promise<ToolResult>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Tool "${toolId}" execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error(`Tool "${toolId}" execution aborted by caller.`));
          });
        }
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;

      console.log(`[ToolExecutor] [${agent.name}] Tool "${toolId}" finished in ${durationMs}ms (success: ${result.success})`);
      return result;

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.warn(`[ToolExecutor] Security Blocked / Execution failed for tool "${toolId}" in ${durationMs}ms: ${err.message || err}`);
      return {
        success: false,
        output: "",
        error: err.message || String(err),
        durationMs,
      };
    }
  }
}
