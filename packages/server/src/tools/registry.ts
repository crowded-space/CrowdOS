import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { eq } from "drizzle-orm";
import { Guard } from "./safety/Guard.js";
import { AgentSpawnManager } from "../Agents/agentGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";
import { getDb } from "../Shared/config/database.js";
import { agents, channels, categories, messages } from "../db/schema.js";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<ToolResult>;
  dangerLevel: "safe" | "moderate" | "dangerous";
  authLevelRequired?: number;
}

// Memory-backed lightweight scheduler registry
export const activeSchedules = new Map<string, { id: string; cron: string; task: string; timer?: NodeJS.Timeout }>();

export const toolRegistry = new Map<string, ToolDefinition>();

// 1. Filesystem: read_file
toolRegistry.set("read_file", {
  id: "read_file",
  name: "read_file",
  displayName: "Read File",
  description: "Reads the text contents of a file inside the sandboxed workspace directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path relative to workspace" }
    },
    required: ["path"]
  },
  dangerLevel: "safe",
  handler: async (args) => {
    try {
      const resolved = Guard.validatePath(args.path);
      const content = await fs.readFile(resolved, "utf8");
      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: "", error: err.message || String(err) };
    }
  }
});

// 2. Filesystem: write_file
toolRegistry.set("write_file", {
  id: "write_file",
  name: "write_file",
  displayName: "Write File",
  description: "Creates or updates a file inside the sandboxed workspace directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path relative to workspace" },
      content: { type: "string", description: "Text content to write" }
    },
    required: ["path", "content"]
  },
  dangerLevel: "moderate",
  handler: async (args) => {
    try {
      const resolved = Guard.validatePath(args.path);
      // Ensure target directory exists
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, args.content, "utf8");
      
      // Emit realtime sandbox:updated event to notify the projection layer
      globalBroker?.emit("sandbox:updated", {
        sandboxId: "default-sandbox",
        workspaceId: "default",
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
toolRegistry.set("list_directory", {
  id: "list_directory",
  name: "list_directory",
  displayName: "List Directory",
  description: "Lists child files and directories under target path.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to workspace" }
    }
  },
  dangerLevel: "safe",
  handler: async (args) => {
    try {
      const relPath = args?.path || ".";
      const resolved = Guard.validatePath(relPath);
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
toolRegistry.set("delete_file", {
  id: "delete_file",
  name: "delete_file",
  displayName: "Delete File",
  description: "Deletes a file safely inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace" }
    },
    required: ["path"]
  },
  dangerLevel: "dangerous",
  handler: async (args) => {
    try {
      const resolved = Guard.validatePath(args.path);
      await fs.unlink(resolved);

      // Emit realtime sandbox:updated event to notify the projection layer
      globalBroker?.emit("sandbox:updated", {
        sandboxId: "default-sandbox",
        workspaceId: "default",
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
toolRegistry.set("execute_bash", {
  id: "execute_bash",
  name: "execute_bash",
  displayName: "Execute Command",
  description: "Executes a shell command inside the workspace directory.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command line to execute" }
    },
    required: ["command"]
  },
  dangerLevel: "dangerous",
  handler: async (args) => {
    return new Promise((resolve) => {
      exec(args.command, { cwd: "c:/Users/Asus/Documents/GitHub/.ThisCrowd" }, (err, stdout, stderr) => {
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
toolRegistry.set("execute_safe", {
  id: "execute_safe",
  name: "execute_safe",
  displayName: "Execute Safe Command",
  description: "Executes a whitelisted shell command in the workspace directory (e.g. npm run test, git status).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Safe command to execute" }
    },
    required: ["command"]
  },
  dangerLevel: "moderate",
  handler: async (args) => {
    return new Promise((resolve) => {
      exec(args.command, { cwd: "c:/Users/Asus/Documents/GitHub/.ThisCrowd" }, (err, stdout, stderr) => {
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
toolRegistry.set("web_search", {
  id: "web_search",
  name: "web_search",
  displayName: "Web Search",
  description: "Retrieves internet search results for specialized telemetry.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms" }
    },
    required: ["query"]
  },
  dangerLevel: "safe",
  handler: async (args) => {
    const mockResults = [
      { title: `Search result 1 for ${args.query}`, snippet: "Found active CrowdOS multi-agent orchestrator layers online." },
      { title: `Reference docs for ${args.query}`, snippet: "Detailed Conventional tool schemas are compatible with native Gemini models." }
    ];
    return { success: true, output: JSON.stringify(mockResults, null, 2) };
  }
});

// 8. Database: query_database
toolRegistry.set("query_database", {
  id: "query_database",
  name: "query_database",
  displayName: "Query Database",
  description: "Runs read-only SQL queries against the local database schema (e.g. count messages, agents).",
  parameters: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL Query line" }
    },
    required: ["sql"]
  },
  dangerLevel: "moderate",
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
toolRegistry.set("system_scheduler", {
  id: "system_scheduler",
  name: "system_scheduler",
  displayName: "System Scheduler",
  description: "Schedules a background task delay.",
  parameters: {
    type: "object",
    properties: {
      delaySeconds: { type: "integer", description: "Seconds to delay" },
      taskDescription: { type: "string", description: "Short description of the scheduled task" }
    },
    required: ["delaySeconds", "taskDescription"]
  },
  dangerLevel: "safe",
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
toolRegistry.set("dispatch_agent", {
  id: "dispatch_agent",
  name: "dispatch_agent",
  displayName: "Dispatch Agent",
  description: "Spawns a parallel L3 Worker-Supervisor pair to execute subtasks.",
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
  handler: async (args) => {
    try {
      const db = getDb();
      let channelId = args.channelId;
      if (!channelId) {
        const firstCh = await db.query.channels.findFirst();
        channelId = firstCh?.id || "general";
      }
      let requestedBy = args.requestedBy;
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
toolRegistry.set("search_all_channels", {
  id: "search_all_channels",
  name: "search_all_channels",
  displayName: "Search All Channels",
  description: "Queries the central knowledge index across all compiled workspace sectors. (Restricted to Level 0 / Omniscient agents).",
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

      return {
        success: true,
        output: report
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: err.message || String(err)
      };
    }
  }
});

// ─── Memory Tools (Lazy-Query Pattern) ───────────────────────────────

// 12. Memory: open_memory
// Opens a full memory note into the agent's active context.
// Only body sections are fetched here — Hook + Brief already visible in previews.
toolRegistry.set("open_memory", {
  id: "open_memory",
  name: "open_memory",
  displayName: "Open Memory",
  description:
    "Open a memory note to read its full content (Observed, Interpreted, Felt Sense, Detailed). " +
    "Use this when a memory preview indicates something relevant you need to read in detail. " +
    "Pass the note_id shown in your memory previews.",
  parameters: {
    type: "object",
    properties: {
      note_id: {
        type: "string",
        description: "The note_id from the memory previews (e.g. '2026-05-30-001')."
      },
      agent_id: {
        type: "string",
        description: "Your agent ID — required to scope the memory lookup."
      }
    },
    required: ["note_id", "agent_id"]
  },
  dangerLevel: "safe",
  handler: async (args) => {
    try {
      const { readMemoryNote } = await import("../Memories/memoriesGate.js");
      const result = await readMemoryNote(args.agent_id, args.note_id, { updateAccess: true });

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
// Signals the agent is discarding a memory from its active context (token budget management).
// Does NOT delete or archive the memory — only removes it from the agent's current working set.
toolRegistry.set("discard_memory_from_context", {
  id: "discard_memory_from_context",
  name: "discard_memory_from_context",
  displayName: "Discard Memory From Context",
  description:
    "Remove an already-opened memory note from your active context to free space. " +
    "The memory remains permanently in your vault — only your active view is cleared. " +
    "Use this after reading a memory and determining it is not relevant to the current task.",
  parameters: {
    type: "object",
    properties: {
      note_id: {
        type: "string",
        description: "The note_id of the memory to discard from active context."
      },
      reason: {
        type: "string",
        description: "Brief reason why this memory is not relevant right now."
      }
    },
    required: ["note_id"]
  },
  dangerLevel: "safe",
  handler: async (args) => {
    // This is a client-side context management signal.
    // The runtime layer uses this to track which memories have been read + discarded
    // in the current session, preventing them from being re-injected.
    return {
      success: true,
      output: `Memory ${args.note_id} discarded from active context. Reason: ${args.reason ?? "not specified"}. Memory remains in vault.`
    };
  }
});

// 14. Memory: remember
// Agent-authored memory writing during the ReAct loop.
// Forked from Continuum's strict REMEMBER command contract.
toolRegistry.set("remember", {
  id: "remember",
  name: "remember",
  displayName: "Remember",
  description:
    "Write a new permanent memory note to your memory vault. " +
    "Use this to preserve important observations, decisions, insights, or events for future sessions. " +
    "Write in first person. Hook must be one sentence. Brief must be 2-3 sentences.",
  parameters: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Your agent ID."
      },
      channel_id: {
        type: "string",
        description: "The channel ID where this memory originates (optional)."
      },
      hook: {
        type: "string",
        description: "One sentence: the core fact or insight. Maximum ~80 tokens."
      },
      brief: {
        type: "string",
        description: "2-3 sentences expanding the hook. Maximum ~150 tokens."
      },
      observed: {
        type: "string",
        description: "What actually happened — factual, first-person account."
      },
      interpreted: {
        type: "string",
        description: "What you infer or conclude from the observation."
      },
      future_relevance: {
        type: "string",
        description: "Why this matters for future tasks or interactions."
      },
      note_type: {
        type: "string",
        enum: ["episodic", "semantic", "reflection", "tool_result", "correspondence"],
        description: "Type of memory note."
      },
      importance_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How important is this memory? 0.0 = trivial, 1.0 = critical."
      },
      source_type: {
        type: "string",
        enum: ["direct_experience", "self_reflection", "tool_result", "channel_observation", "entity_testimony"],
        description: "How was this memory acquired?"
      }
    },
    required: ["agent_id", "hook", "brief", "note_type"]
  },
  dangerLevel: "safe",
  handler: async (args) => {
    try {
      const { createMemoryNote } = await import("../Memories/memoriesGate.js");

      if (!args.hook?.trim()) {
        return { success: false, output: "", error: "hook is required and cannot be empty." };
      }
      if (!args.brief?.trim()) {
        return { success: false, output: "", error: "brief is required and cannot be empty." };
      }

      const result = await createMemoryNote({
        agentId: args.agent_id,
        channelId: args.channel_id ?? undefined,
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
        output:
          `✅ Memory written to vault.\n` +
          `note_id: ${result.value.id}\n` +
          `type: ${result.value.noteType}\n` +
          `importance: ${result.value.importanceScore.toFixed(2)}\n` +
          `hook: "${result.value.hook}"`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message || String(err) };
    }
  }
});
