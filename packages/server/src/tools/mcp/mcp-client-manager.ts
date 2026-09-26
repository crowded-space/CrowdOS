import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { McpFraming, McpServerConfig, McpServerStatus, McpRawTool } from "./mcp-types.js";
import {
  MCP_PROTOCOL_VERSION,
  DEFAULT_MCP_FRAMING,
  DEFAULT_MCP_DANGER_LEVEL,
  MCP_DANGER_TO_AUTH_LEVEL,
} from "./mcp-types.js";
import type { ToolDefinition, ToolResult, ToolExecutionContext, ToolDangerLevel } from "../tool-types.js";
import { toolRegistry } from "../tool-registry.js";
import { killProcessTree } from "../safety/hardened-exec.js";
import { isSensitiveKey, redactLogPayload } from "../../shared/core/redact.js";
import { decryptRecordValues } from "../../shared/core/secret-box.js";

const REQUEST_TIMEOUT_MS = 30000;
const STDIN_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
const KILL_ESCALATION_MS = 5000;
const CIRCUIT_BREAKER_THRESHOLD = 5;

export class McpServerCrashedError extends Error {
  readonly serverId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  constructor(serverId: string, exitCode: number | null, signal: string | null, message?: string) {
    super(message ?? `MCP server '${serverId}' exited unexpectedly (code=${exitCode}, signal=${signal ?? "none"})`);
    this.name = "McpServerCrashedError";
    this.serverId = serverId;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

interface McpPendingRequest {
  resolve: (res: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface McpProcessSession {
  config: McpServerConfig;
  process?: ChildProcess;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  lastError?: string;
  tools: Map<string, ToolDefinition>;
  requestId: number;
  pendingRequests: Map<number | string, McpPendingRequest>;
  stdinBuffer: Buffer;
  exited: boolean;
  framing: McpFraming;
  consecutiveFailures: number;
}

const DANGER_SEVERITY: Record<ToolDangerLevel, number> = { safe: 0, moderate: 1, dangerous: 2 };

function severityMax(a: ToolDangerLevel, b: ToolDangerLevel): ToolDangerLevel {
  return DANGER_SEVERITY[a] >= DANGER_SEVERITY[b] ? a : b;
}

function resolveDangerLevel(config: McpServerConfig, raw: McpRawTool): ToolDangerLevel {
  const floor = config.defaultDangerLevel ?? DEFAULT_MCP_DANGER_LEVEL;
  // Server-provided claims (MCP annotations) may only ESCALATE above the
  // config floor — a compromised server can never downgrade itself to safe.
  const claimed: ToolDangerLevel | undefined =
    raw.annotations?.destructiveHint === true ? "dangerous" : undefined;
  return claimed ? severityMax(claimed, floor) : floor;
}

function buildChildEnv(config: McpServerConfig): Record<string, string> {
  // Hardened: shell:false + env allowlist — never inherit full process.env (P0-5)
  const allowedEnvKeys = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USER", "LANG", "LC_ALL", "NODE_ENV",
    "MCP_TRANSPORT",
  ]);
  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allowedEnvKeys.has(k) && v) filteredEnv[k] = v;
  }

  const declared = new Set(config.requiredEnvVars ?? []);
  const droppedUndeclared: string[] = [];
  // SEC-4: env var values arrive envelope-encrypted; decrypt at this single
  // consumption point so plaintext only exists inside the child env map.
  const resolvedEnvVars = decryptRecordValues(config.envVars);
  for (const [k, v] of Object.entries(resolvedEnvVars ?? {})) {
    if (v === undefined) continue;
    if (!isSensitiveKey(k) || declared.has(k)) {
      filteredEnv[k] = v;
    } else {
      droppedUndeclared.push(k);
    }
  }

  if (droppedUndeclared.length > 0 || declared.size > 0) {
    const declaredButUnset = Array.from(declared).filter(
      (k) => config.envVars?.[k] === undefined
    );
    if (droppedUndeclared.length > 0 || declaredButUnset.length > 0) {
      console.warn(
        `[MCP:${config.id}] env policy applied`,
        redactLogPayload({
          serverId: config.id,
          droppedUndeclaredSensitiveKeys: droppedUndeclared.sort(),
          declaredButUnsetKeys: declaredButUnset.sort(),
          hint: "secret-shaped vars are only forwarded when listed in requiredEnvVars",
        })
      );
    }
  }

  return filteredEnv;
}

function encodeFrame(framing: McpFraming, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (framing === "content-length") {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"), body]);
  }
  return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}

function extractFrames(framing: McpFraming, buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let pos = 0;
  if (framing === "content-length") {
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n", pos);
      if (headerEnd === -1) break;
      const header = buffer.slice(pos, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        pos = headerEnd + 4;
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number.parseInt(match[1], 10);
      if (buffer.length < bodyEnd) break;
      messages.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
      pos = bodyEnd;
    }
  } else {
    for (;;) {
      const nl = buffer.indexOf(0x0a, pos);
      if (nl === -1) break;
      const line = buffer.slice(pos, nl).toString("utf8").trim();
      pos = nl + 1;
      if (line) messages.push(line);
    }
  }
  return { messages, rest: buffer.slice(pos) };
}

export class McpClientManager extends EventEmitter {
  private sessions: Map<string, McpProcessSession> = new Map();
  // In-flight connects: two concurrent connect() calls for one server must
  // share one handshake, not spawn two children (orphan + double-register).
  private connecting: Map<string, Promise<McpServerStatus>> = new Map();

  async registerServer(config: McpServerConfig): Promise<void> {
    // Shape validation at the trust boundary. NOTE: stdio spawn of an
    // arbitrary command is inherent to MCP (servers ARE local processes) and
    // the HTTP layer is loopback-trusted single-user by design (see routes);
    // this validation rejects malformed configs, not the model itself.
    if (!config || typeof config.id !== "string" || !config.id.trim()) {
      throw new Error("MCP server registration requires a non-empty string id.");
    }
    if (/[./\\]/.test(config.id)) throw new Error(`MCP server id "${config.id}" must not contain path separators.`);
    if (config.transport === "stdio") {
      if (typeof config.command !== "string" || !config.command.trim()) {
        throw new Error(`MCP server '${config.id}': stdio transport requires a non-empty command.`);
      }
      if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((a) => typeof a === "string"))) {
        throw new Error(`MCP server '${config.id}': args must be an array of strings.`);
      }
    }
    if (this.sessions.has(config.id)) {
      await this.disconnect(config.id);
    }

    const session: McpProcessSession = {
      config,
      status: 'disconnected',
      tools: new Map(),
      requestId: 1,
      pendingRequests: new Map(),
      stdinBuffer: Buffer.alloc(0),
      exited: false,
      framing: config.framing ?? DEFAULT_MCP_FRAMING,
      consecutiveFailures: 0,
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
    const inflight = this.connecting.get(serverId);
    if (inflight) return inflight;

    session.status = 'connecting';
    session.lastError = undefined;
    session.exited = false;
    session.stdinBuffer = Buffer.alloc(0);

    try {
      const task = (async (): Promise<McpServerStatus> => {
        if (session.config.transport === 'stdio') {
          await this.connectStdio(session);
        } else {
          throw new Error(`Transport '${session.config.transport}' not yet fully implemented in mock/prototype mode`);
        }

        session.consecutiveFailures = 0;
        session.status = 'connected';
        return this.getStatus(serverId)!;
      })();
      this.connecting.set(serverId, task);
      try {
        return await task;
      } finally {
        this.connecting.delete(serverId);
      }
    } catch (err: any) {
      session.status = 'error';
      session.lastError = err.message;
      this.failPending(session, err instanceof Error ? err : new Error(String(err)));
      // A failed handshake may have already registered tools (tools/list can
      // succeed before a later step throws). Leaving them registered would
      // advertise a dead server's tools in the registry listing, so clean up
      // exactly as the exit path does.
      this.cleanupTools(session);
      this.killChild(session);
      session.process = undefined;
      throw err;
    }
  }

  private async connectStdio(session: McpProcessSession): Promise<void> {
    const { command, args = [] } = session.config;
    if (!command) throw new Error(`Command required for stdio transport`);

    const child = spawn(command, args, {
      env: buildChildEnv(session.config),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // POSIX: own process group so killProcessTree(-pid) reaches grandchildren
      // (pipes stay attached). Windows: detached would give the child its own
      // console and sever stdio; taskkill /T covers the tree without it.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    session.process = child;

    // Stale-child guards: a reconnect replaces session.process, so late events
    // from the previous child must not tear down the new session's state.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (session.process !== child) return;
      this.handleStdioData(session, chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (session.process !== child) return;
      console.warn(`[MCP:${session.config.id}:stderr]`, chunk.toString('utf-8'));
    });

    child.on('error', (err) => {
      if (session.process !== child) return;
      session.lastError = err.message;
      if (session.exited) return;
      session.exited = true;
      session.status = 'error';
      this.failPending(
        session,
        new McpServerCrashedError(session.config.id, null, null, `MCP server '${session.config.id}' spawn failed: ${err.message}`)
      );
      this.cleanupTools(session);
    });

    child.on('exit', (code, signal) => {
      if (session.process !== child) return;
      if (session.exited) return;
      session.exited = true;
      if (session.status !== 'error') session.status = 'disconnected';
      session.stdinBuffer = Buffer.alloc(0);
      session.process = undefined;
      this.failPending(session, new McpServerCrashedError(session.config.id, code, signal));
      this.cleanupTools(session);
    });

    // 1. Send initialize request
    const requestedVersion = session.config.protocolVersion ?? MCP_PROTOCOL_VERSION;
    const initRes = await this.sendJsonRpc(session, 'initialize', {
      protocolVersion: requestedVersion,
      capabilities: { tools: {} },
      clientInfo: { name: 'CrowdOS', version: '2.0.0' },
    });

    const negotiated = initRes?.protocolVersion;
    if (negotiated && negotiated !== requestedVersion) {
      console.warn(
        `[MCP:${session.config.id}] protocol version drift`,
        redactLogPayload({ requested: requestedVersion, serverReturned: negotiated })
      );
    }

    // 2. Send initialized notification
    this.sendNotification(session, 'notifications/initialized', {});

    // 3. List tools
    const toolsRes = await this.sendJsonRpc(session, 'tools/list', {});
    const rawTools: McpRawTool[] = toolsRes?.tools || [];

    // 4. Register each tool
    for (const raw of rawTools) {
      const dangerLevel = resolveDangerLevel(session.config, raw);
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
        dangerLevel,
        authLevelRequired: MCP_DANGER_TO_AUTH_LEVEL[dangerLevel],
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
            if (err instanceof McpServerCrashedError) throw err;
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

  private handleStdioData(session: McpProcessSession, chunk: Buffer): void {
    if (session.exited) return;
    if (session.stdinBuffer.length + chunk.length > STDIN_BUFFER_MAX_BYTES) {
      session.stdinBuffer = Buffer.alloc(0);
      this.recordFailure(session, 'stdout buffer exceeded 10MB cap');
      this.killChild(session);
      this.failPending(session, new McpServerCrashedError(session.config.id, null, null, `MCP server '${session.config.id}' exceeded stdout buffer cap (10MB)`));
      return;
    }
    session.stdinBuffer = Buffer.concat([session.stdinBuffer, chunk]);
    const { messages, rest } = extractFrames(session.framing, session.stdinBuffer);
    session.stdinBuffer = rest;

    for (const text of messages) {
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue;
      const pending = session.pendingRequests.get(msg.id);
      if (!pending) continue;
      session.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        session.consecutiveFailures = 0;
        pending.resolve(msg.result);
      }
    }
  }

  private failPending(session: McpProcessSession, err: Error): void {
    const entries = Array.from(session.pendingRequests.values());
    session.pendingRequests.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private recordFailure(session: McpProcessSession, reason: string): void {
    session.consecutiveFailures += 1;
    if (session.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      session.status = 'error';
      session.lastError = `MCP server '${session.config.id}' disabled after ${session.consecutiveFailures} consecutive failures (last: ${reason})`;
    }
  }

  private killChild(session: McpProcessSession): void {
    const child = session.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Tree kill (grandchildren orphaned otherwise) — same killer as hardened exec.
    if (child.pid) {
      try { killProcessTree(child.pid); } catch { /* best-effort */ }
    }
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    const t = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
    }, KILL_ESCALATION_MS);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  private sendJsonRpc(session: McpProcessSession, method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (session.exited || !session.process || !session.process.stdin) {
        return reject(new McpServerCrashedError(session.config.id, null, null, `MCP server '${session.config.id}' is not running`));
      }
      const id = session.requestId++;
      const entry: McpPendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!session.pendingRequests.has(id)) return;
          session.pendingRequests.delete(id);
          this.recordFailure(session, `'${method}' timed out`);
          this.killChild(session);
          reject(new Error(`MCP Request timed out for method '${method}'`));
        }, REQUEST_TIMEOUT_MS),
      };
      session.pendingRequests.set(id, entry);

      try {
        session.process.stdin.write(encodeFrame(session.framing, { jsonrpc: '2.0', id, method, params }));
      } catch (err: any) {
        session.pendingRequests.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new McpServerCrashedError(session.config.id, null, null, `stdin write failed: ${err.message}`));
      }
    });
  }

  private sendNotification(session: McpProcessSession, method: string, params: any): void {
    if (session.exited || !session.process || !session.process.stdin) return;
    try {
      session.process.stdin.write(encodeFrame(session.framing, { jsonrpc: '2.0', method, params }));
    } catch {}
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
      this.killChild(session);
      session.process = undefined;
    }
    session.exited = true;
    this.failPending(session, new McpServerCrashedError(serverId, null, null, `MCP server '${serverId}' disconnected`));
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
