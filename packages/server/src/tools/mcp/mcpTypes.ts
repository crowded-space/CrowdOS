export type McpTransport = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  serverUrl?: string;
  envVars?: Record<string, string>;
  autoStart?: boolean;
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
}
