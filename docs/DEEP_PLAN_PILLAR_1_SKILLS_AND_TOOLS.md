# 🛠️ Deep Planning: Pillar 1 — Modular Skill & Tool Architecture

> **Document ID:** DEEP_PLAN_PILLAR_1_SKILLS_AND_TOOLS  
> **Status:** Approved Architecture Specification  
> **Target Version:** CrowdOS Modular 2.0  
> **Owner:** AI Agent Systems Architect & Core Engine Team  

---

## 1. Executive Summary & Objective

In modern agentic systems, rigid hardcoded tools and vague "capability" definitions lead to brittle execution, security vulnerabilities, and high maintenance overhead. 

The goal of **Pillar 1** is to build an **extensible, plug-and-play Skill & Tool Subsystem** for CrowdOS that:
1. Clearly separates atomic **Tools** from procedural **Skills** and external **MCP Connectors**.
2. Enables **dynamic tool mounting** at runtime without requiring server rebuilds or hardcoded TypeScript edits.
3. Implements first-class **Model Context Protocol (MCP)** support to connect CrowdOS agents to any external tool ecosystem (GitHub, PostgreSQL, Slack, Docker, Linear, Filesystem).
4. Enforces **strict sandboxing, resource limits, timeout guards, and authority permissions** across all tool executions.

---

## 2. Abstraction Boundaries: Tools vs Skills vs Capabilities vs MCP

| Abstraction | Definition & Responsibilities | Execution / Runtime Form |
| :--- | :--- | :--- |
| **Tool** | An atomic, stateless functional primitive with strict input parameters and deterministic return values. Does not contain high-level reasoning. | Function with JSON Schema + executable handler (Native TS, Sandboxed JS, or Shell). |
| **Skill** | A composite, goal-oriented procedural package. Combines specialized instructions, few-shot examples, required tools, and execution policy (e.g. Plan -> Execute -> Verify). | Bundle of prompt guidelines, required tool dependencies, and few-shot reasoning patterns. |
| **MCP Connector** | Standardized client interface to external tool providers compliant with Anthropic/OpenAI MCP specification. | JSON-RPC client over stdio, SSE, or HTTP transport. |
| **Toolkit Pack** | A curated collection of tools grouped by domain (e.g. "DevOps Pack", "Data Engineering Pack"). | Reusable permission bundle assignable to agents with 1-click. |

---

## 3. Tool Subsystem Architecture

### 3.1 Unified Tool Manifest (ToolDefinition)

Every tool in CrowdOS—whether native, dynamic, or MCP-derived—conforms to a single canonical TypeScript interface:

\\\	ypescript
// packages/server/src/tools/toolTypes.ts

export type ToolSourceType = 'native' | 'dynamic' | 'mcp' | 'openapi';
export type ToolDangerLevel = 'safe' | 'moderate' | 'dangerous';

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
    items?: Record<string, unknown>;
    default?: unknown;
  }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolExecutionContext {
  agentId: string;
  channelId: string;
  workspaceId: string;
  actorId: string;
  authorityLevel: number;
  abortSignal: AbortSignal;
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  artifacts?: Array<{
    type: string;
    path: string;
    mimeType: string;
    metadata?: Record<string, unknown>;
  }>;
  durationMs: number;
}

export interface ToolDefinition {
  id: string;                         // Unique slug, e.g. "vfs_read_file", "github_create_issue"
  name: string;                       // Function call identifier: /^[a-zA-Z0-9_-]{1,64}$/
  displayName: string;                // User-friendly label for UI
  description: string;                // Clear explanation for LLM tool selection
  category: string;                   // 'filesystem' | 'database' | 'code' | 'web' | 'mcp' | 'custom'
  sourceType: ToolSourceType;
  sourceId?: string;                  // FK to mcp_servers or dynamic_tools table
  parameters: ToolParameterSchema;
  dangerLevel: ToolDangerLevel;
  authLevelRequired: number;          // 0 (Omniscient), 1 (CEO), 2 (Manager), 3 (Worker)
  timeoutMs: number;                  // Default: 30,000ms
  handler: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolResult>;
}
\\\

---

### 3.2 Dynamic Tool Execution & Isolation

Dynamic user-defined tools are executed in an isolated VM context with strict capability-based security:
- **HTTP / OpenAPI Tool**: Configurable URL, header templates, domain whitelist check, response trimming.
- **Sandboxed JS Script**: Isolated Node.js execution with memory ceiling (64MB) and execution timeout (10,000ms).

---

### 3.3 Model Context Protocol (MCP) Client Engine

CrowdOS connects to external MCP tool servers using standard transports:
- Spawns process (stdio) or connects to remote endpoint (SSE / HTTP).
- Performs JSON-RPC handshake (initialize -> 	ools/list).
- Auto-transforms remote tool schemas into canonical ToolDefinition[] prefixed with mcp:<serverId>:<toolName>.
- Proxies 	ools/call invocations and normalizes outputs into ToolResult.

---

## 4. Skill Subsystem Architecture

### 4.1 Skill Definition & Composition

A **Skill** elevates an agent from an atomic tool executor to a **specialized problem solver**:

\\\	ypescript
// packages/server/src/Skills/skillTypes.ts

export interface SkillPromptLayer {
  systemPromptAdditions: string[];    // Domain rules, e.g. "Always write unit tests first"
  executionGuidelines: string[];      // Step-by-step procedure rules
  fewShotExamples?: Array<{
    scenario: string;
    thoughtProcess: string;
    actions: Array<{ tool: string; args: Record<string, unknown> }>;
    expectedOutcome: string;
  }>;
}

export interface SkillDefinition {
  id: string;                         // e.g. "skill_db_optimizer"
  name: string;                       // "PostgreSQL Query Optimizer"
  description: string;                // Overview of the skill
  category: string;                   // "Database", "DevOps", "Frontend", "QA"
  icon?: string;
  requiredToolIds: string[];          // Auto-injected tools: ['query_database', 'vfs_read_file']
  optionalToolIds?: string[];
  promptLayer: SkillPromptLayer;
  recommendedModels?: string[];       // Best suited LLMs (e.g. "gemini-2.0-flash", "claude-sonnet-4")
  workflowPattern: 'react' | 'plan_execute' | 'evaluator_optimizer';
  createdAt: Date;
  updatedAt: Date;
}
\\\

---

## 5. Database Schema: Unified Modular Tools & Skills

To replace the orphaned capabilities modules and hardcoded tool arrays, we implement a normalized relational schema with full N:M link tables:

\\\	ypescript
// packages/server/src/db/schema.ts (Additions for Pillar 1)

import { pgTable, text, integer, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./schema.js";

export const toolSourceEnum = pgEnum("tool_source", ["native", "dynamic", "mcp", "openapi"]);
export const toolDangerLevelEnum = pgEnum("tool_danger_level", ["safe", "moderate", "dangerous"]);
export const mcpTransportEnum = pgEnum("mcp_transport", ["stdio", "sse", "http"]);

// 1. Tool Master Catalog
export const tools = pgTable("tools", {
  id: text("id").primaryKey(),                          // "read_file", "mcp_github_create_pr"
  name: text("name").notNull().unique(),                // Function calling identifier
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  sourceType: toolSourceEnum("source_type").notNull().default("native"),
  sourceId: text("source_id"),                          // FK to mcp_servers.id or dynamic_tools.id
  parameters: jsonb("parameters").notNull(),            // JSON Schema compliant parameters
  dangerLevel: toolDangerLevelEnum("danger_level").notNull().default("safe"),
  authLevelRequired: integer("auth_level_required").notNull().default(3), // L3 by default
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 2. External MCP Server Registrations
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),                          // "mcp_github", "mcp_postgres"
  name: text("name").notNull(),
  transport: mcpTransportEnum("transport").notNull().default("stdio"),
  command: text("command"),                             // e.g. "npx"
  args: jsonb("args").<string[]>().default(sql'[]'::jsonb),
  serverUrl: text("server_url"),                        // For SSE/HTTP transports
  envVars: jsonb("env_vars").<Record<string, string>>().default(sql'{}'::jsonb),
  status: text("status").notNull().default("disconnected"), // "connected" | "disconnected" | "error"
  lastError: text("last_error"),
  autoStart: boolean("auto_start").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 3. Dynamic User-Defined Tools
export const dynamicTools = pgTable("dynamic_tools", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  parameters: jsonb("parameters").notNull(),
  scriptContent: text("script_content"),                // JS script or HTTP template
  httpConfig: jsonb("http_config").<{
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers: Record<string, string>;
  }>(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 4. Skills Catalog
export const skills = pgTable("skills", {
  id: text("id").primaryKey(),                          // "skill_code_audit"
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  icon: text("icon").default("⚡"),
  promptLayer: jsonb("prompt_layer").notNull().default(sql'{}'::jsonb),
  workflowPattern: text("workflow_pattern").notNull().default("react"),
  requiredTools: jsonb("required_tools").<string[]>().notNull().default(sql'[]'::jsonb),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 5. Agent N:M Link Tables
export const agentTools = pgTable("agent_tools", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  toolId: text("tool_id").notNull().references(() => tools.id, { onDelete: "cascade" }),
  isExplicit: boolean("is_explicit").notNull().default(true),
});

export const agentSkills = pgTable("agent_skills", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  isEnabled: boolean("is_enabled").notNull().default(true),
});
\\\

---

## 6. Domain Facade Standard: toolsGate.ts & skillsGate.ts

In accordance with CrowdOS Domain Facade Standards (AGENTS.md), all external consumers interact strictly through public gates:

\\\	ypescript
// packages/server/src/tools/toolsGate.ts
export { toolRegistry } from "./toolRegistry.js";
export { ToolExecutor } from "./ToolExecutor.js";
export { mcpClientManager } from "./mcp/mcpClientManager.js";
export type { ToolDefinition, ToolResult, ToolExecutionContext, ToolParameterSchema } from "./toolTypes.js";

export const toolsGate = {
  get: (toolId: string) => toolRegistry.get(toolId),
  list: (filters?: { category?: string; authLevel?: number }) => toolRegistry.list(filters),
  register: (def: ToolDefinition) => toolRegistry.register(def),
  unregister: (toolId: string) => toolRegistry.unregister(toolId),
  execute: (agentId: string, toolId: string, args: Record<string, unknown>, ctx: Partial<ToolExecutionContext>) => 
    ToolExecutor.execute(agentId, toolId, args, ctx),
  connectMcpServer: (serverId: string) => mcpClientManager.connect(serverId),
  disconnectMcpServer: (serverId: string) => mcpClientManager.disconnect(serverId),
};
\\\

---

## 7. Security, Sandboxing & Threat Model

| Risk Vector | Threat Description | Architectural Mitigation |
| :--- | :--- | :--- |
| **Path Traversal** | Agent invokes \fs_read_file\ with \../../etc/passwd\ | Dynamic root enforcement against \workspace.rootPath\ with POSIX path resolution normalization. |
| **Process Exhaustion** | Tool hangs indefinitely (e.g. infinite loop in bash) | Hard timeout per tool execution via \AbortController\ (default 30s) + SIGKILL on spawned processes. |
| **Privilege Escalation** | L3 worker attempts calling \ipolar_dispatch\ or \query_database\ | Role-based check on \	ool.authLevelRequired <= agent.authorityLevel\ before execution. |
| **Unsafe Command Execution** | Agent runs destructive shell commands | Whitelist execution mode (\execute_safe\) for untrusted tiers; containerized docker sandbox for dangerous commands. |
| **MCP Server Poisoning** | External MCP server emits malformed schemas | Strict Zod validation of all remote schemas before injecting into model context packets. |

---

## 8. Implementation Steps & Verification Matrix

- [ ] **Step 1.1**: Define TypeScript interfaces in \packages/server/src/tools/toolTypes.ts\ and \src/Skills/skillTypes.ts\.
- [ ] **Step 1.2**: Update Drizzle database schema with \	ools\, \mcp_servers\, \dynamic_tools\, \skills\, and link tables.
- [ ] **Step 1.3**: Refactor \ToolExecutor.ts\ to support dynamic execution context, timeouts, and multi-source dispatch.
- [ ] **Step 1.4**: Implement \MCPClientManager\ with stdio & SSE transport adapters.
- [ ] **Step 1.5**: Create REST API endpoints in \outes/tools.ts\ and \outes/skills.ts\ for catalog management.
- [ ] **Step 1.6**: Write automated unit tests for tool resolution, schema validation, authorization, and timeout aborts.
