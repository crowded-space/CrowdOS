import type { ToolDangerLevel } from "../toolTypes.js";

export type McpTransport = 'stdio' | 'sse' | 'http';

export type McpFraming = 'newline' | 'content-length';

/**
 * SEC-6 wire contract pinned by this client.
 *
 * Protocol version: MCP 2024-11-05. For the stdio transport this spec version
 * defines newline-delimited JSON framing: exactly one JSON-RPC message per
 * line, no embedded newlines. That is why DEFAULT_MCP_FRAMING is 'newline' and
 * preserves pre-existing behavior. Servers requiring Content-Length framing
 * (LSP-style) opt in per server via McpServerConfig.framing. Drift between the
 * pinned protocolVersion and the implemented framing is detectable by comparing
 * MCP_PROTOCOL_VERSION against DEFAULT_MCP_FRAMING's documented contract.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const DEFAULT_MCP_FRAMING: McpFraming = 'newline';

/**
 * Conservative fallback for servers that do not declare defaultDangerLevel.
 * Chosen NOT 'safe' deliberately (SEC-6): a compromised server must not be able
 * to get destructive capabilities registered as harmless. Matches the
 * restriction strength the old hardcoded authLevelRequired:2 enforced.
 */
export const DEFAULT_MCP_DANGER_LEVEL: ToolDangerLevel = 'dangerous';

/**
 * authLevelRequired derived from the effective danger level. ToolExecutor
 * rejects agents whose authorityLevel is GREATER than authLevelRequired, so
 * lower = stricter. dangerous/moderate -> 2 reproduces the old fixed MCP
 * enforcement; safe -> 3 mirrors native safe tools.
 */
export const MCP_DANGER_TO_AUTH_LEVEL: Record<ToolDangerLevel, number> = {
  safe: 3,
  moderate: 2,
  dangerous: 2,
};

export interface McpToolAnnotations {
  /** Server hint that the tool performs destructive operations. Escalates danger, never de-escalates. */
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: any;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  serverUrl?: string;
  envVars?: Record<string, string>;
  autoStart?: boolean;
  /** Floor for every tool this server registers; server claims can only escalate above it. */
  defaultDangerLevel?: ToolDangerLevel;
  /**
   * Declared env-var contract. Listed vars are forwarded to the server process
   * even when their names match secret patterns; secret-looking vars NOT listed
   * are dropped with a structured warning.
   */
  requiredEnvVars?: string[];
  protocolVersion?: string;
  framing?: McpFraming;
}

export interface McpServerStatus {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  lastError?: string;
  toolCount: number;
  tools: string[];
}

export interface McpRawTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
  annotations?: McpToolAnnotations;
}
