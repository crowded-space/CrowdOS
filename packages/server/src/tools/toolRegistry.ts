import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { eq } from "drizzle-orm";
import { Guard } from "./safety/Guard.js";
import { AgentSpawnManager } from "../Agents/agentGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";
import { getDb } from "../Shared/config/database.js";
import { agents } from "../db/schema.js";
import type { ToolDefinition, ToolResult, ToolExecutionContext } from "./toolTypes.js";

export const activeSchedules = new Map<string, { id: string; cron: string; task: string; timer?: NodeJS.Timeout }>();

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerNativeTools();
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(toolName: string): boolean {
    return this.tools.delete(toolName);
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  list(filters?: { category?: string; authLevel?: number }): ToolDefinition[] {
    let all = Array.from(this.tools.values());
    if (filters?.category) {
      all = all.filter(t => t.category === filters.category);
    }
    if (filters?.authLevel !== undefined) {
      all = all.filter(t => (t.authLevelRequired ?? 3) <= filters.authLevel!);
    }
    return all;
  }

  private registerNativeTools(): void {
    // 1. Filesystem: read_file
    this.register({
      id: "read_file",
      name: "read_file",
      displayName: "Read File",
      description: "Reads the text contents of a file inside the sandboxed workspace directory.",
      category: "filesystem",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target file path relative to workspace" }
        },
        required: ["path"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const resolved = Guard.validatePath(args.path, ctx?.workspaceId);
          const content = await fs.readFile(resolved, "utf8");
          return { success: true, output: content };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 2. Filesystem: write_file
    this.register({
      id: "write_file",
      name: "write_file",
      displayName: "Write File",
      description: "Creates or updates a file inside the sandboxed workspace directory.",
      category: "filesystem",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target file path relative to workspace" },
          content: { type: "string", description: "Text content to write" }
        },
        required: ["path", "content"]
      },
      dangerLevel: "moderate",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const resolved = Guard.validatePath(args.path, ctx?.workspaceId);
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, args.content, "utf8");
          
          globalBroker?.emit("sandbox:updated", {
            sandboxId: ctx?.workspaceId || "default-sandbox",
            workspaceId: ctx?.workspaceId || "default",
            path: args.path,
            changeType: "modify",
            timestamp: new Date().toISOString()
          });

          return { success: true, output: `Successfully wrote file to ${args.path}` };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 3. Filesystem: list_directory
    this.register({
      id: "list_directory",
      name: "list_directory",
      displayName: "List Directory",
      description: "Lists child files and directories under target path.",
      category: "filesystem",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace" }
        }
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const relPath = args?.path || ".";
          const resolved = Guard.validatePath(relPath, ctx?.workspaceId);
          const items = await fs.readdir(resolved, { withFileTypes: true });
          const mapped = items.map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            isFile: item.isFile()
          }));
          return { success: true, output: JSON.stringify(mapped, null, 2) };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 4. Filesystem: delete_file
    this.register({
      id: "delete_file",
      name: "delete_file",
      displayName: "Delete File",
      description: "Deletes a file safely inside the workspace.",
      category: "filesystem",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace" }
        },
        required: ["path"]
      },
      dangerLevel: "dangerous",
      authLevelRequired: 2,
      handler: async (args, ctx) => {
        try {
          const resolved = Guard.validatePath(args.path, ctx?.workspaceId);
          await fs.unlink(resolved);

          globalBroker?.emit("sandbox:updated", {
            sandboxId: ctx?.workspaceId || "default-sandbox",
            workspaceId: ctx?.workspaceId || "default",
            path: args.path,
            changeType: "delete",
            timestamp: new Date().toISOString()
          });

          return { success: true, output: `Successfully deleted file ${args.path}` };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 5. Terminal: execute_bash
    this.register({
      id: "execute_bash",
      name: "execute_bash",
      displayName: "Execute Command",
      description: "Executes a shell command inside the workspace directory.",
      category: "terminal",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line to execute" }
        },
        required: ["command"]
      },
      dangerLevel: "dangerous",
      authLevelRequired: 1,
      handler: async (args, ctx) => {
        return new Promise((resolve) => {
          Guard.validateCommand(args.command);
          const cwd = Guard.getWorkspaceDir(ctx?.workspaceId);
          exec(args.command, { cwd }, (err, stdout, stderr) => {
            if (err) {
              resolve({ success: false, output: stdout, error: stderr || err.message });
            } else {
              resolve({ success: true, output: stdout });
            }
          });
        });
      }
    });

    // 6. Terminal: execute_safe
    this.register({
      id: "execute_safe",
      name: "execute_safe",
      displayName: "Execute Safe Command",
      description: "Executes a whitelisted shell command in the workspace directory (e.g. npm run test, git status).",
      category: "terminal",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Safe command to execute" }
        },
        required: ["command"]
      },
      dangerLevel: "moderate",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        return new Promise((resolve) => {
          if (!Guard.isCommandWhitelisted(args.command)) {
            return resolve({ success: false, output: "", error: `Command '${args.command}' is not in the safe whitelist.` });
          }
          const cwd = Guard.getWorkspaceDir(ctx?.workspaceId);
          exec(args.command, { cwd }, (err, stdout, stderr) => {
            if (err) {
              resolve({ success: false, output: stdout, error: stderr || err.message });
            } else {
              resolve({ success: true, output: stdout });
            }
          });
        });
      }
    });

    // 7. Search: web_search
    this.register({
      id: "web_search",
      name: "web_search",
      displayName: "Web Search",
      description: "Retrieves internet search results for specialized telemetry.",
      category: "search",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms" }
        },
        required: ["query"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args) => {
        const mockResults = [
          { title: `Search result for ${args.query}`, snippet: "CrowdOS multi-agent orchestrator documentation and references." }
        ];
        return { success: true, output: JSON.stringify(mockResults, null, 2) };
      }
    });

    // 8. Database: query_database
    this.register({
      id: "query_database",
      name: "query_database",
      displayName: "Query Database",
      description: "Runs read-only SQL queries against the local database schema (e.g. count messages, agents).",
      category: "database",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL Query line" }
        },
        required: ["sql"]
      },
      dangerLevel: "moderate",
      authLevelRequired: 1,
      handler: async (args) => {
        try {
          const sqlLower = args.sql.toLowerCase();
          if (sqlLower.includes("delete") || sqlLower.includes("update") || sqlLower.includes("insert") || sqlLower.includes("drop")) {
            throw new Error("Mutation blocked: read-only queries only.");
          }
          const db = getDb();
          const result = await db.query.agents.findMany({ limit: 5 });
          return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 9. Scheduling: system_scheduler
    this.register({
      id: "system_scheduler",
      name: "system_scheduler",
      displayName: "System Scheduler",
      description: "Schedules a background task delay.",
      category: "system",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          delaySeconds: { type: "integer", description: "Seconds to delay" },
          taskDescription: { type: "string", description: "Short description of the scheduled task" }
        },
        required: ["delaySeconds", "taskDescription"]
      },
      dangerLevel: "safe",
      authLevelRequired: 2,
      handler: async (args) => {
        const id = `sched-${Date.now()}`;
        const timer = setTimeout(() => {
          console.log(`[Scheduler] Task triggered successfully: ${args.taskDescription}`);
          activeSchedules.delete(id);
        }, args.delaySeconds * 1000);

        activeSchedules.set(id, {
          id,
          cron: `in subtask${args.delaySeconds}s`,
          task: args.taskDescription,
          timer
        });

        return { success: true, output: `Successfully scheduled task: "${args.taskDescription}" in ${args.delaySeconds} seconds. ID: ${id}` };
      }
    });

    // 10. Multi-Agent spawning: dispatch_agent
    this.register({
      id: "dispatch_agent",
      name: "dispatch_agent",
      displayName: "Dispatch Agent",
      description: "Spawns a parallel L3 Worker-Supervisor pair to execute subtasks.",
      category: "swarm",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          workerTemplateId: { type: "string" },
          supervisorTemplateId: { type: "string" },
          subtasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                instructions: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] }
              },
              required: ["id", "title", "instructions", "priority"]
            }
          },
          failurePolicy: { type: "string", enum: ["retry", "escalate"] },
          maxRetries: { type: "integer" },
          channelId: { type: "string" },
          requestedBy: { type: "string" }
        },
        required: ["workerTemplateId", "supervisorTemplateId", "subtasks", "failurePolicy", "maxRetries"]
      },
      dangerLevel: "moderate",
      authLevelRequired: 2,
      handler: async (args, ctx) => {
        try {
          const db = getDb();
          let channelId = args.channelId || ctx?.channelId;
          if (!channelId) {
            const firstCh = await db.query.channels.findFirst();
            channelId = firstCh?.id || "general";
          }
          let requestedBy = args.requestedBy || ctx?.agentId;
          if (!requestedBy) {
            const firstAgent = await db.query.agents.findFirst({
              where: eq(agents.isTemplate, false),
            });
            requestedBy = firstAgent?.id || "agent-l1";
          }

          if (!globalBroker) {
            throw new Error("EventBroker not initialized.");
          }

          const report = await AgentSpawnManager.dispatchAgent(globalBroker, requestedBy, channelId, {
            workerTemplateId: args.workerTemplateId,
            supervisorTemplateId: args.supervisorTemplateId,
            subtasks: args.subtasks,
            failurePolicy: args.failurePolicy || "retry",
            maxRetries: args.maxRetries ?? 3,
          });

          return {
            success: report.status === "completed",
            output: JSON.stringify(report, null, 2),
          };
        } catch (err: any) {
          return {
            success: false,
            output: "",
            error: err.message || String(err),
          };
        }
      }
    });

    // 11. Omniscient Search: search_all_channels
    this.register({
      id: "search_all_channels",
      name: "search_all_channels",
      displayName: "Search All Channels",
      description: "Queries the central knowledge index across all compiled workspace sectors. (Restricted to Level 0 / Omniscient agents).",
      category: "search",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" }
        },
        required: ["query"]
      },
      dangerLevel: "safe",
      authLevelRequired: 0,
      handler: async (args) => {
        try {
          const db = getDb();
          const { channelIndex } = await import("../db/schema.js");
          const indices = await db.select().from(channelIndex);
          const query = (args.query || "").toLowerCase();
          
          const matching = indices.filter(idx => 
            idx.topicSummary.toLowerCase().includes(query) || 
            idx.channelPath.toLowerCase().includes(query)
          );

          if (matching.length === 0) {
            return {
              success: true,
              output: `🔍 Search query "${args.query}" produced 0 matching sectors.`
            };
          }

          let report = `🔍 Search query "${args.query}" produced ${matching.length} matching sectors:\n\n`;
          matching.forEach(idx => {
            report += `### 📁 Sector: \`${idx.channelPath}\` \n`;
            report += `* **Last indexed**: ${new Date(idx.lastIndexedAt).toLocaleTimeString()}\n`;
            report += `* **Summary**: ${idx.topicSummary}\n\n`;
          });

          return { success: true, output: report };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 12. Memory: open_memory
    this.register({
      id: "open_memory",
      name: "open_memory",
      displayName: "Open Memory",
      description:
        "Open a memory note to read its full content (Observed, Interpreted, Felt Sense, Detailed). " +
        "Use this when a memory preview indicates something relevant you need to read in detail. " +
        "Pass the note_id shown in your memory previews.",
      category: "memory",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "The note_id from the memory previews." },
          agent_id: { type: "string", description: "Your agent ID." }
        },
        required: ["note_id", "agent_id"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { readMemoryNote } = await import("../Memories/memoriesGate.js");
          const agentId = args.agent_id || ctx?.agentId || "agent-raven";
          const result = await readMemoryNote(agentId, args.note_id, { updateAccess: true });

          if (!result.ok) {
            return { success: false, output: "", error: result.error.message };
          }

          const note = result.value;
          const sections: string[] = [];

          if (note.observed)        sections.push(`**Observed:**\n${note.observed}`);
          if (note.interpreted)     sections.push(`**Interpreted:**\n${note.interpreted}`);
          if (note.feltSense)       sections.push(`**Felt Sense:**\n${note.feltSense}`);
          if (note.futureRelevance) sections.push(`**Future Relevance:**\n${note.futureRelevance}`);
          if (note.uncertainty)     sections.push(`**Uncertainty:**\n${note.uncertainty}`);
          if (note.detailed)        sections.push(`**Detailed:**\n${note.detailed}`);

          const body = sections.length > 0 ? sections.join("\n\n") : "(No body content written yet.)";
          const hasTension = note.contradictionFlags.length > 0
            ? `\n⚠️ Contradiction flags: ${note.contradictionFlags.join(", ")}`
            : "";

          const output =
            `[Memory Opened: ${note.id}]\n` +
            `Type: ${note.noteType} | Confidence: ${note.confidence} | Importance: ${note.importanceScore.toFixed(2)}\n` +
            `Timestamp: ${note.noteTimestamp.toISOString()}${hasTension}\n\n` +
            `**Hook:** ${note.hook}\n` +
            `**Brief:** ${note.brief}\n\n` +
            body;

          return { success: true, output };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 13. Memory: discard_memory_from_context
    this.register({
      id: "discard_memory_from_context",
      name: "discard_memory_from_context",
      displayName: "Discard Memory From Context",
      description: "Remove an already-opened memory note from your active context to free space.",
      category: "memory",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "The note_id of the memory to discard." },
          reason: { type: "string", description: "Brief reason why this memory is not relevant right now." }
        },
        required: ["note_id"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args) => {
        return {
          success: true,
          output: `Memory ${args.note_id} discarded from active context. Reason: ${args.reason ?? "not specified"}. Memory remains in vault.`
        };
      }
    });

    // 14. Memory: remember
    this.register({
      id: "remember",
      name: "remember",
      displayName: "Remember",
      description: "Write a new permanent memory note to your memory vault.",
      category: "memory",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Your agent ID." },
          channel_id: { type: "string", description: "The channel ID where this memory originates (optional)." },
          hook: { type: "string", description: "One sentence: the core fact or insight." },
          brief: { type: "string", description: "2-3 sentences expanding the hook." },
          observed: { type: "string", description: "What actually happened." },
          interpreted: { type: "string", description: "What you infer or conclude." },
          future_relevance: { type: "string", description: "Why this matters for future tasks." },
          note_type: { type: "string", enum: ["episodic", "semantic", "reflection", "tool_result", "correspondence"] },
          importance_score: { type: "number", minimum: 0, maximum: 1 },
          source_type: { type: "string", enum: ["direct_experience", "self_reflection", "tool_result", "channel_observation", "entity_testimony"] }
        },
        required: ["agent_id", "hook", "brief", "note_type"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { createMemoryNote } = await import("../Memories/memoriesGate.js");
          const agentId = args.agent_id || ctx?.agentId;

          if (!args.hook?.trim()) return { success: false, output: "", error: "hook is required." };
          if (!args.brief?.trim()) return { success: false, output: "", error: "brief is required." };

          const result = await createMemoryNote({
            agentId,
            channelId: args.channel_id ?? ctx?.channelId,
            noteType: args.note_type ?? "episodic",
            importanceScore: args.importance_score ?? 0.5,
            sourceType: args.source_type ?? "direct_experience",
            hook: args.hook,
            brief: args.brief,
            observed: args.observed ?? "",
            interpreted: args.interpreted ?? "",
            futureRelevance: args.future_relevance ?? "",
          });

          if (!result.ok) {
            return { success: false, output: "", error: result.error.message };
          }

          return {
            success: true,
            output: `✅ Memory written to vault. ID: ${result.value.id}`
          };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });
  }
}

export const toolRegistry = new ToolRegistry();
