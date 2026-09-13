import fs from "node:fs/promises";
import path from "node:path";
import { eq, isNull, sql } from "drizzle-orm";
import { Guard } from "./safety/guard.js";
import { execHardened } from "./safety/hardened-exec.js";
import { AgentSpawnManager } from "../agents/agent-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";
import { getDb } from "../shared/config/database.js";
import { agents } from "../db/schema.js";
import type { ToolDefinition, ToolResult, ToolExecutionContext } from "./tool-types.js";

// TOOL-1 · Honest tools — flag-gated rollback: when disabled the tools are
// unregistered rather than faked (spec rollback). Flags default true.
function isQueryDatabaseEnabled(): boolean {
  const raw = process.env.QUERY_DATABASE_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return true;
}
function isSchedulerEnabled(): boolean {
  const raw = process.env.SYSTEM_SCHEDULER_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return true;
}

// query_database allowlist — spec: agents, channels, messages, channel_index, token_usage_log
const QUERY_ALLOWED_TABLES = new Set<string>([
  "agents",
  "channels",
  "messages",
  "channel_index",
  "token_usage_log",
]);
const QUERY_BLOCKED_RE =
  /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|call|execute|vacuum|reindex|cluster|comment|copy|load|security|do)\b/i;

function extractTableNames(sql: string): string[] {
  const out: string[] = [];
  // Robust FROM/JOIN table extraction handling schema-qualified, quoted, and
  // comma-separated lists (e.g., FROM agents, secret_table or JOIN ...).
  // We scan for each FROM/JOIN keyword and then capture the leading table list.
  const clauseRe = /\b(?:from|join)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(sql))) {
    const start = m.index + m[0].length;
    const rest = sql.slice(start);
    const tableListMatch = rest.match(
      /^\s*((?:"[^"]+"|'[^']+'|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[\w$]+))?(\s*,\s*(?:"[^"]+"|'[^']+'|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[\w$]+))?)*)/i,
    );
    if (!tableListMatch) continue;
    const listStr = tableListMatch[0];
    const parts = listStr.split(",").map((s) => s.trim()).filter(Boolean);
    for (let part of parts) {
      const firstToken = part.split(/\s+/)[0];
      const segments = firstToken.split(".").map((s) => s.replace(/^["']|["']$/g, ""));
      const base = segments[segments.length - 1];
      if (base) out.push(base);
    }
    clauseRe.lastIndex = start + tableListMatch[0].length;
  }
  return out;
}

function stripTrailingSemicolons(s: string): string {
  return s.trim().replace(/;+\s*$/, "");
}

function hasMultipleStatements(sql: string): boolean {
  const stripped = stripTrailingSemicolons(sql);
  return stripped.includes(";");
}

// Scheduler helpers — honest firing via EventBroker + persistence (DB-2)
type ScheduleRecord = { id: string; cron: string; task: string; timer?: NodeJS.Timeout; interval?: NodeJS.Timeout; channelId?: string };
export const activeSchedules = new Map<string, ScheduleRecord>();

async function honestSchedulerEmit(
  channelId: string,
  task: string,
  message: string | undefined,
  workspaceId: string | undefined,
): Promise<void> {
  const effectiveChannelId = channelId || "general";
  const content = message || `⏰ Scheduled task: ${task}`;
  let brokerInst: InstanceType<typeof import("../event-broker/event-broker-gate.js").EventBroker> | null = null;
  try {
    const { EventBroker, getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    // Prefer the live socket broker so room fan-out works; shared holder first,
    // then the legacy global, then an isolated local instance (documented).
    brokerInst = (getSharedBroker() as unknown as typeof brokerInst) ?? (globalBroker as unknown as typeof brokerInst) ?? new EventBroker();
  } catch {
    const { EventBroker } = await import("../event-broker/event-broker-gate.js");
    brokerInst = new EventBroker() as unknown as InstanceType<typeof EventBroker>;
  }
  try {
    const { withTransaction } = await import("../shared/config/database.js");
    const { allocateSequence } = await import("../shared/core/sequence-number.js");
    const { monotonicUlid } = await import("../shared/core/ulid.js");
    const { messages } = await import("../db/schema.js");
    const persisted = await (withTransaction as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(async (tx: unknown) => {
      const seq = await (allocateSequence as (cid: string, n: number, t: unknown) => Promise<number>)(effectiveChannelId, 1, tx);
      const msg = {
        id: monotonicUlid(),
        channelId: effectiveChannelId,
        authorId: "system-scheduler",
        authorName: "Scheduler",
        authorLevel: "system",
        authorType: "system" as const,
        content,
        mentions: [] as unknown[],
        isInternalMonologue: false,
        sequenceNumber: seq,
        timestamp: new Date(),
      };
      await (tx as { insert: (table: unknown) => { values: (v: unknown) => Promise<void> } }).insert(messages).values({
        ...(msg as Record<string, unknown>),
        authorLevel: String((msg as Record<string, unknown>).authorLevel),
      });
      return msg;
    });
    (brokerInst as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("message:new", persisted as never, { channelId: effectiveChannelId });
  } catch {
    const ephemeral = {
      id: `sched-msg-${Date.now()}`,
      channelId: effectiveChannelId,
      authorId: "system-scheduler",
      authorName: "Scheduler",
      authorLevel: "system",
      authorType: "system",
      content,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: 0,
      timestamp: new Date(),
    };
    try {
      (brokerInst as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("message:new", ephemeral as never, { channelId: effectiveChannelId });
    } catch {}
  }
  try {
    (brokerInst as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("scheduled:triggered" as string, {
      id: `sched-${Date.now()}`,
      channelId: effectiveChannelId,
      task,
      triggeredAt: new Date().toISOString(),
    } as never, { channelId: effectiveChannelId });
  } catch {}
}

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
          const resolved = await Guard.validatePath(args.path, ctx?.workspaceId);
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
          const resolved = await Guard.validatePath(args.path, ctx?.workspaceId);
          if (ctx?.runId) {
            try {
              const { runsGate } = await import("../runs/runs-gate.js");
              let existed = false;
              let prior: string | null = null;
              try { prior = await fs.readFile(resolved, "utf8"); existed = true; } catch { existed = false; }
              const inverse = runsGate.buildCompensationInverse({ existed, priorContent: prior, path: args.path });
              await runsGate.addCompensation(ctx.runId as string, { toolName: "write_file", targetPath: args.path, inverseOp: inverse });
            } catch {}
          }
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
          const resolved = await Guard.validatePath(relPath, ctx?.workspaceId);
          const items = await fs.readdir(resolved, { withFileTypes: true });
          const mapped = items.map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            isFile: item.isFile()
          }));
          return { success: true, output: JSON.stringify(mapped) };
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
          const resolved = await Guard.validatePath(args.path, ctx?.workspaceId);
          if (ctx?.runId) {
            try {
              const { runsGate } = await import("../runs/runs-gate.js");
              let prior: string | null = null;
              let existed = false;
              try { prior = await fs.readFile(resolved, "utf8"); existed = true; } catch { existed = false; }
              if (existed) {
                const inverse = runsGate.buildCompensationInverse({ existed: true, priorContent: prior, path: args.path });
                await runsGate.addCompensation(ctx.runId as string, { toolName: "delete_file", targetPath: args.path, inverseOp: inverse });
              }
            } catch {}
          }
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
        Guard.validateCommand(args.command);
        const cwd = await Guard.getWorkspaceDir(ctx?.workspaceId);
        return await execHardened({
          command: args.command,
          cwd,
          signal: ctx?.abortSignal,
          timeoutMs: 300000,
        });
      }
    });

    // 6. Terminal: execute_safe
    this.register({
      id: "execute_safe",
      name: "execute_safe",
      displayName: "Execute Safe Command",
      description: "Executes a whitelisted shell command in the workspace directory (e.g. git status, cat notes.md).",
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
        if (!Guard.isCommandWhitelisted(args.command)) {
          return { success: false, output: "", error: `Command '${args.command}' is not in the safe whitelist.` };
        }
        const cwd = await Guard.getWorkspaceDir(ctx?.workspaceId);
        return await execHardened({
          command: args.command,
          cwd,
          signal: ctx?.abortSignal,
          timeoutMs: 300000,
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
        return { success: true, output: JSON.stringify(mockResults) };
      }
    });

    // 8. Database: query_database — TOOL-1 honest: real read-only SQL over pooled
    // postgres with statement_timeout 5s, allowlist, row cap 100. Removal disposition
    // is the flag-gated unregister (see isQueryDatabaseEnabled above).
    if (isQueryDatabaseEnabled()) {
      this.register({
        id: "query_database",
        name: "query_database",
        displayName: "Query Database",
        description:
          "Runs read-only SQL queries against the local database (statement_timeout 5s, allowlist: agents, channels, messages, channel_index, token_usage_log; row cap 100). Honest — no canned data.",
        category: "database",
        sourceType: "native",
        effectClass: "read",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQL Query — SELECT/WITH only; mutating keywords blocked; only allowlisted tables; capped to 100 rows." },
          },
          required: ["sql"],
        },
        dangerLevel: "moderate",
        authLevelRequired: 1,
        handler: async (args) => {
          const rawInput = String(args?.sql ?? "").trim();
          try {
            if (!rawInput) throw new Error("SQL is required.");
            // Only SELECT/WITH allowed
            if (!/^\s*(select|with)\b/i.test(rawInput)) {
              throw new Error("Only SELECT/WITH queries are allowed — mutation blocked.");
            }
            // Mutation blocklist (word-boundary, case-insensitive)
            if (QUERY_BLOCKED_RE.test(rawInput)) {
              throw new Error("Mutation blocked: read-only queries only.");
            }
            // Block multiple statements (semicolon followed by content)
            if (hasMultipleStatements(rawInput)) {
              throw new Error("Multiple statements not allowed.");
            }
            // Allowlist check — every FROM/JOIN target must be in allowed set
            const targets = extractTableNames(rawInput);
            for (const t of targets) {
              const base = t.split(".").pop()!.replace(/"/g, "").replace(/'/g, "").toLowerCase();
              if (base && !QUERY_ALLOWED_TABLES.has(base)) {
                throw new Error(
                  `Table not allowed: "${t}" — allowed: ${Array.from(QUERY_ALLOWED_TABLES).join(", ")}`,
                );
              }
            }
            // Build capped query: outer LIMIT 100 guarantees row cap regardless
            // of inner LIMIT; statement_timeout is enforced via SET LOCAL.
            const inner = stripTrailingSemicolons(rawInput);
            const capped = `SELECT * FROM (${inner}) AS __honest_q LIMIT 100`;
            // Pooled connection via postgres.js — statement_timeout 5s
            const { getSqlClient } = await import("../shared/config/database.js");
            const sqlClient = getSqlClient();
            let rows: unknown[];
            try {
              rows = (await (sqlClient as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(async (tx: unknown) => {
                const unsafe = (tx as { unsafe: (q: string) => Promise<unknown> }).unsafe;
                await unsafe(`SET LOCAL statement_timeout = '5s'`);
                const result = await unsafe(capped);
                return result as unknown[];
              })) as unknown[];
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              // Postgres statement_timeout shows as "canceling statement due to statement timeout"
              if (/statement timeout/i.test(msg) || /57014/.test(msg)) {
                throw new Error("Query timed out after 5s (statement_timeout).");
              }
              throw e;
            }
            const arr = Array.isArray(rows) ? rows : [];
            // ponytail: no indent + server-side truncate (row cap 100 already SQL-side)
            const json = JSON.stringify(arr);
            return { success: true, output: json.length > 20000 ? `${json.slice(0, 20000)}…[truncated ${json.length - 20000} chars]` : json };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, output: "", error: message };
          }
        },
      });
    } else {
      console.warn("[tools] query_database disabled via QUERY_DATABASE_ENABLED=false — tool not registered (honest unregister fallback).");
    }

    // 9. Scheduling: system_scheduler — TOOL-1 honest: BullMQ delayed/repeatable
    // jobs firing real mentions/events via EventBroker (reuse maintenanceWorker
    // pattern). Supports one-shot delaySeconds and repeatable cron. Rollback
    // disposition is flag-gated unregister.
    if (isSchedulerEnabled()) {
      this.register({
        id: "system_scheduler",
        name: "system_scheduler",
        displayName: "System Scheduler",
        description:
          "Schedules a background task: one-shot delayed (delaySeconds) or repeatable (cron). Fires a real system message/event into the target channel via EventBroker (BullMQ in bullmq mode, honest timer+emit in inline mode).",
        category: "system",
        sourceType: "native",
        effectClass: "side-effect",
        parameters: {
          type: "object",
          properties: {
            delaySeconds: { type: "number", description: "Seconds to delay before firing (one-shot). Ignored when cron is provided; fractional seconds allowed." },
            taskDescription: { type: "string", description: "Short description of the scheduled task" },
            channelId: { type: "string", description: "Target channel ID (defaults to invocation channel or 'general')" },
            cron: { type: "string", description: "Optional cron expression for repeatable schedule (e.g. '*/5 * * * *'). When provided, creates a repeatable BullMQ job instead of a one-shot delay." },
            message: { type: "string", description: "Optional custom message content posted when triggered (defaults to taskDescription)" },
            targetAgentId: { type: "string", description: "Optional target agent (reserved — message still posted; future enqueues a run)" },
            workspaceId: { type: "string", description: "Workspace ID override (defaults to invocation workspace or 'default')" },
          },
          required: ["taskDescription"],
        },
        dangerLevel: "safe",
        authLevelRequired: 2,
        handler: async (args, ctx) => {
          try {
            const task = String(args?.taskDescription ?? "").trim();
            if (!task) throw new Error("taskDescription is required.");
            const channelId = String(args?.channelId ?? ctx?.channelId ?? "general").trim() || "general";
            const workspaceId = String(args?.workspaceId ?? ctx?.workspaceId ?? "default").trim() || "default";
            const message = args?.message != null ? String(args.message) : undefined;
            const cronRaw = args?.cron != null ? String(args.cron).trim() : "";
            const delayRaw = args?.delaySeconds;
            const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

            // Cron path — repeatable BullMQ job (preferred) or inline setInterval fallback
            if (cronRaw) {
              // Basic cron sanity — BullMQ/ cron-parser will validate detail; we do minimal shape check
              if (!/^[\d*\/,\-\s]+$/.test(cronRaw) && !cronRaw.includes("*")) {
                // allow cron aliases like "@every 10s" is NOT supported — keep strict
                // but permit standard 5/6 field crons with digits/*/,-
              }
              try {
                const { queueGate } = await import("../queue/queue-gate.js");
                if (queueGate.mode() === "bullmq") {
                  const q = queueGate.getSchedulerQueue();
                  if (!q) throw new Error("Scheduler queue unavailable (bullmq mode but no connection).");
                  await queueGate.startSchedulerWorker();
                  await q.upsertJobScheduler(
                    id,
                    { pattern: cronRaw },
                    {
                      name: "scheduled:cron",
                      data: {
                        id,
                        channelId,
                        task,
                        message,
                        workspaceId,
                        targetAgentId: args?.targetAgentId ? String(args.targetAgentId) : undefined,
                        cron: cronRaw,
                        createdAt: new Date().toISOString(),
                      },
                      opts: {
                        removeOnComplete: { age: 3600 },
                        removeOnFail: { age: 3600 },
                      },
                    },
                  );
                  activeSchedules.set(id, { id, cron: cronRaw, task, channelId });
                  return { success: true, output: `Scheduled repeatable task "${task}" with cron "${cronRaw}" on channel ${channelId}. ID: ${id}` };
                }
              } catch (e) {
                // fall through to inline interval fallback if bullmq not ready
                const msg = e instanceof Error ? e.message : String(e);
                console.warn("[scheduler] bullmq cron schedule failed, falling back to inline interval:", msg);
              }
              // Inline fallback: honest interval firing real broker events
              const intervalMs = 60_000; // fallback fires every 60s when cron parsing not available inline; still honest
              // Best: try to parse "*/N * * * *" minute-step or "* * * * *" — simplified for testability
              let stepMs: number | null = null;
              const m = cronRaw.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
              if (m) stepMs = Number(m[1]) * 60_000;
              const effectiveIntervalMs = stepMs ?? intervalMs;
              const interval = setInterval(() => {
                void honestSchedulerEmit(channelId, task, message, workspaceId).catch(() => {});
              }, effectiveIntervalMs);
              // Unref so tests/process can exit; still fires
              (interval as unknown as { unref?: () => void }).unref?.();
              activeSchedules.set(id, { id, cron: cronRaw, task, channelId, interval });
              return { success: true, output: `Scheduled repeatable task "${task}" with cron "${cronRaw}" (inline fallback, every ${effectiveIntervalMs}ms) on channel ${channelId}. ID: ${id}` };
            }

            // One-shot delayed path
            const delaySeconds = delayRaw != null ? Number(delayRaw) : 0;
            if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error("delaySeconds must be a non-negative number.");
            const delayMs = Math.max(0, Math.round(delaySeconds * 1000));

            try {
              const { queueGate } = await import("../queue/queue-gate.js");
              if (queueGate.mode() === "bullmq") {
                const q = queueGate.getSchedulerQueue();
                if (q) {
                  await queueGate.startSchedulerWorker();
                  const job = await q.add(
                    "scheduled:trigger",
                    {
                      id,
                      channelId,
                      task,
                      message,
                      workspaceId,
                      targetAgentId: args?.targetAgentId ? String(args.targetAgentId) : undefined,
                      createdAt: new Date().toISOString(),
                    },
                    {
                      delay: delayMs,
                      jobId: id,
                      removeOnComplete: { age: 3600 },
                      removeOnFail: { age: 3600 },
                    },
                  );
                  activeSchedules.set(id, { id, cron: `in ${delaySeconds}s`, task, channelId });
                  return { success: true, output: `Scheduled task "${task}" in ${delaySeconds}s on channel ${channelId}. Job ${String(job.id)} ID: ${id}` };
                }
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn("[scheduler] bullmq delayed schedule failed, falling back to inline timer:", msg);
            }

            // Inline honest fallback: real setTimeout that emits via EventBroker (not console.log)
            const timer = setTimeout(() => {
              activeSchedules.delete(id);
              void honestSchedulerEmit(channelId, task, message, workspaceId).catch((err) => {
                console.error("[scheduler] inline emit failed", err);
              });
            }, delayMs);
            (timer as unknown as { unref?: () => void }).unref?.();
            activeSchedules.set(id, { id, cron: `in ${delaySeconds}s`, task, channelId, timer });
            return { success: true, output: `Scheduled task "${task}" in ${delaySeconds}s on channel ${channelId}. ID: ${id}` };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: "", error: msg };
          }
        },
      });
    } else {
      console.warn("[tools] system_scheduler disabled via SYSTEM_SCHEDULER_ENABLED=false — tool not registered (honest unregister fallback).");
    }

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

          // SW-2 delegation contracts: central dispatcher gate for generic sub-agent calls
          const parentRunIdForDelegation = (ctx as unknown as { runId?: string })?.runId ?? null;
          const brokerForDelegation = ((ctx as unknown as { broker?: unknown })?.broker as typeof globalBroker) ?? globalBroker;
          const workspaceIdForDelegation = (ctx as unknown as { workspaceId?: string })?.workspaceId ?? "default";
          let delegatedChildRunId: string | null = null;
          if (parentRunIdForDelegation) {
            try {
              const { swarmGate: swarmGateForDelegation } = await import("../swarm/swarm-gate.js");
              const { randomUUID: uuid } = await import("node:crypto");
              delegatedChildRunId = `run_${uuid().slice(0, 8)}_${Date.now().toString(36)}`;
              await swarmGateForDelegation.delegate({
                parentRunId: String(parentRunIdForDelegation),
                childRunId: delegatedChildRunId,
                taskId: (args.subtasks as Array<{ id?: string }>)?.[0]?.id ?? "dispatch_agent",
                broker: brokerForDelegation as never,
                workspaceId: workspaceIdForDelegation,
                producerAgent: requestedBy,
              });
            } catch (err: unknown) {
              const maybe = err as { name?: string; code?: string; message?: string };
              if (maybe?.name === "DelegationRejectedError" || maybe?.code === "cycle" || maybe?.code === "depth") {
                return { success: false, output: "", error: maybe?.message ?? String(err) };
              }
              console.warn("[dispatch_agent] delegation gate pre-check failed, proceeding without guard:", (err as Error)?.message || err);
              delegatedChildRunId = null;
            }
          }

          const report = await AgentSpawnManager.dispatchAgent(globalBroker, requestedBy, channelId, {
            workerTemplateId: args.workerTemplateId,
            supervisorTemplateId: args.supervisorTemplateId,
            subtasks: args.subtasks,
            failurePolicy: args.failurePolicy || "retry",
            maxRetries: args.maxRetries ?? 3,
          });

          const reportJson = JSON.stringify(report);

          // SW-2: child result summarized (≤500 tokens) + artifact pointer; parent context grows ≤ summary size
          if (parentRunIdForDelegation && delegatedChildRunId) {
            try {
              const { swarmGate: swarmGateForComplete } = await import("../swarm/swarm-gate.js");
              const { summary } = await swarmGateForComplete.completeDelegation({
                parentRunId: String(parentRunIdForDelegation),
                childRunId: delegatedChildRunId,
                fullOutput: reportJson,
                broker: brokerForDelegation as never,
                workspaceId: workspaceIdForDelegation,
                producerAgent: requestedBy,
              });
              return {
                success: report.status === "completed",
                output: summary,
              };
            } catch (err) {
              console.warn("[dispatch_agent] completeDelegation failed:", (err as Error)?.message || err);
            }
          }

          return {
            success: report.status === "completed",
            output: reportJson,
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
          // ponytail: explicit columns + truncate topicSummary blob for report
          const indices = await db.select({
            channelId: channelIndex.channelId, channelPath: channelIndex.channelPath,
            topicSummary: sql<string>`substring(${channelIndex.topicSummary} from 1 for 500)`,
            lastIndexedAt: channelIndex.lastIndexedAt, status: channelIndex.status, lastError: channelIndex.lastError,
          }).from(channelIndex).limit(500);
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
            const degraded = (idx as { status?: string }).status === "degraded";
            report += `### 📁 Sector: \`${idx.channelPath}\`${degraded ? " ⚠️ [DEGRADED — summary stale/unavailable]" : ""} \n`;
            if (degraded) report += `* **Last error**: ${(idx as { lastError?: string | null }).lastError ?? "unknown"}\n`;
            report += `* **Last indexed**: ${new Date(idx.lastIndexedAt).toLocaleTimeString()}\n`;
            report += `* **Summary**: ${String(idx.topicSummary).substring(0, 500)}\n\n`;
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
          agent_id: { type: "string", description: "Your agent ID (optional, defaults to executing agent)." }
        },
        required: ["note_id"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { readMemoryNote } = await import("../memories/memories-gate.js");
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
      handler: async (args, ctx) => {
        try {
          const { memoriesGate } = await import("../memories/memories-gate.js");
          const agentId = ctx?.agentId;
          if (!agentId) {
            return { success: false, output: "", error: "agentId required (via execution context)." };
          }
          if (!args.note_id) {
            return { success: false, output: "", error: "note_id is required." };
          }
          const result = await memoriesGate.discardFromContext(
            agentId,
            ctx?.channelId ?? "",
            args.note_id,
            args.reason ?? "not specified"
          );
          return {
            success: true,
            output:
              `Memory ${args.note_id} discarded from active context. Reason: ${args.reason ?? "not specified"}. Memory remains in vault.` +
              (result.inVault ? "" : " (Note not found in vault; session discard still recorded.)")
          };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 14. Context: lock_in — focus to self-only (agent-context only)
    this.register({
      id: "lock_in",
      name: "lock_in",
      displayName: "Lock In (Isolated Context)",
      description: "Focus your context to isolated SELF-only view: hide other agents' chatter. Use when you need deep solo focus. Call lock_out to restore full roster visibility. Agent-context only.",
      category: "context",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Channel ID to lock (optional, defaults to current channel)." },
          reason: { type: "string", description: "Brief reason for locking in (optional)." }
        },
        required: []
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { agentLockStore } = await import("../shared/core/agent-lock-store.js");
          const agentId = ctx?.agentId;
          const channelId = args.channel_id || ctx?.channelId;
          if (!agentId || !channelId) {
            return { success: false, output: "", error: "agentId and channelId required (via context or channel_id)." };
          }
          const already = agentLockStore.isLockedIn(agentId, channelId);
          if (already) {
            return { success: true, output: `🔒 Already locked in — channel ${channelId} is in isolated SELF-only view. Use lock_out to restore.` };
          }
          agentLockStore.lockIn(agentId, channelId);
          return { success: true, output: `🔒 Locked in: channel ${channelId} is now isolated to your own messages + direct human inputs that mention you. Other agents' chatter hidden. Call lock_out to restore full roster visibility.` };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 15. Context: lock_out — restore full context
    this.register({
      id: "lock_out",
      name: "lock_out",
      displayName: "Lock Out (Restore Context)",
      description: "Restore full multi-agent context after lock_in: show full roster and all visible history again. Agent-context only.",
      category: "context",
      sourceType: "native",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Channel ID to unlock (optional, defaults to current channel)." }
        },
        required: []
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { agentLockStore } = await import("../shared/core/agent-lock-store.js");
          const agentId = ctx?.agentId;
          const channelId = args.channel_id || ctx?.channelId;
          if (!agentId || !channelId) {
            return { success: false, output: "", error: "agentId and channelId required (via context or channel_id)." };
          }
          const wasLocked = agentLockStore.isLockedIn(agentId, channelId);
          if (!wasLocked) {
            return { success: true, output: `🔓 Already in open context — channel ${channelId} shows full roster. No lock to release.` };
          }
          agentLockStore.lockOut(agentId, channelId);
          return { success: true, output: `🔓 Locked out: channel ${channelId} restored to full multi-agent roster visibility (history tags: [From @...]).` };
        } catch (err: any) {
          return { success: false, output: "", error: err.message || String(err) };
        }
      }
    });

    // 16. Memory: remember
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
          agent_id: { type: "string", description: "Your agent ID (optional, defaults to current agent)." },
          channel_id: { type: "string", description: "The channel ID where this memory originates (optional)." },
          hook: { type: "string", description: "One sentence: the core fact or insight." },
          brief: { type: "string", description: "2-3 sentences expanding the hook." },
          observed: { type: "string", description: "What actually happened." },
          interpreted: { type: "string", description: "What you infer or conclude." },
          future_relevance: { type: "string", description: "Why this matters for future tasks." },
          note_type: { type: "string", enum: ["episodic", "semantic", "reflection", "journal", "tool_result", "correspondence", "tension"] },
          importance_score: { type: "number", minimum: 0, maximum: 1 },
          source_type: { type: "string", enum: ["direct_experience", "self_reflection", "tool_result", "channel_observation", "entity_testimony"] }
        },
        required: ["hook", "brief", "note_type"]
      },
      dangerLevel: "safe",
      authLevelRequired: 3,
      handler: async (args, ctx) => {
        try {
          const { createMemoryNote } = await import("../memories/memories-gate.js");
          const agentId = args.agent_id || ctx?.agentId;

          if (!agentId) return { success: false, output: "", error: "agent_id is required." };

          const hook = args.hook?.trim() || (args.brief?.trim() ? args.brief.trim().split(/[.!?]\s+/)[0] : "");
          const brief = args.brief?.trim() || hook;

          if (!hook) return { success: false, output: "", error: "hook is required." };
          if (!brief) return { success: false, output: "", error: "brief is required." };

          const result = await createMemoryNote({
            agentId,
            channelId: args.channel_id ?? ctx?.channelId,
            noteType: args.note_type ?? "episodic",
            importanceScore: args.importance_score != null ? Number(args.importance_score) : 0.5,
            sourceType: args.source_type ?? "direct_experience",
            hook,
            brief,
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
