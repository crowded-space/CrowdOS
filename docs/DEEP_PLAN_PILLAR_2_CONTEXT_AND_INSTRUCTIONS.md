# 🧠 Deep Planning: Pillar 2 — Composable Context Assembly & Instruction Middleware Pipeline

> **Document ID:** DEEP_PLAN_PILLAR_2_CONTEXT_AND_INSTRUCTIONS  
> **Status:** Approved Architecture Specification  
> **Target Version:** CrowdOS Modular 2.0  
> **Owner:** AI Agent Systems Architect & Core Engine Team  

---

## 1. Executive Summary & Objective

In monolithic agent frameworks, system prompts are assembled as static, concatenated strings. When new requirements arise (such as memory previews, tool definitions, safety invariants, runtime overrides, or channel visibility rules), developers keep tacking on code until the prompt assembler becomes an unmaintainable dumping ground.

The goal of **Pillar 2** is to replace the hardcoded prompt builders with a **Composable Context Middleware Pipeline**. 

Context compilation will work exactly like an HTTP request pipeline (e.g. Express/Koa/Fastify middlewares):
1. Each cognitive component is an isolated, testable **Context Middleware**.
2. Middlewares execute in a deterministic, prioritized sequence.
3. Middlewares can inspect, mutate, or prepend/append blocks to the final ContextPacket.
4. Prompt layers (instructions, personas, formatting rules) can be **stacked, reordered, and hot-swapped** without touching engine code.
5. The Hybrid 3-Tier Token Management (Pinned, Sliding Window, DB-Cached Summaries) and Visibility Matrix are unified into the pipeline.

---

## 2. The Context Middleware Pipeline Architecture

`
                                    ┌────────────────────────────────────────────────────────┐
                                    │                   INCOMING REQUEST                     │
                                    │    (agentId, channelId, workspaceId, userInput)        │
                                    └───────────────────────────┬────────────────────────────┘
                                                                │
                                                                ▼
                                    ┌────────────────────────────────────────────────────────┐
                                    │               ContextPipelineManager                   │
                                    │             (Runs Middlewares in Order)                │
                                    └───────────────────────────┬────────────────────────────┘
                                                                │
     ┌──────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┐
     ▼                                                                                                                     ▼
┌──────────────────────────────────────────────┐                                                      ┌──────────────────────────────────────────────┐
│ 1. IdentityAuthorityMiddleware               │                                                      │ 5. ConstraintSafetyMiddleware                │
│    • Injects Agent Name, Avatar, Tier        │                                                      │    • Injects Disallowed Actions              │
│    • Injects L0/L1/L2/L3 Authority Context   │                                                      │    • Injects Strict Invariant Safety Rules   │
├──────────────────────────────────────────────┤                                                      ├──────────────────────────────────────────────┤
│ 2. InstructionStackMiddleware                │                                                      │ 6. MemoryRetrievalMiddleware                 │
│    • Resolves Stack of Instruction Modules   │                                                      │    • Evaluates Multi-Lane Memory Candidates  │
│    • Injects Base + Persona + Domain Expertise│                                                     │    • Injects Compact <memory_previews> Block │
│    • Injects Active Runtime Overrides        │                                                      ├──────────────────────────────────────────────┤
├──────────────────────────────────────────────┤                                                      │ 7. VisibilityMatrixMiddleware                │
│ 3. SkillContextMiddleware                    │                                                      │    • Filters Channel Messages by Policy      │
│    • Resolves Active Agent Skills            │                                                      │      (None, Horizontal, Vertical, Full)      │
│    • Injects Skill Workflows & Guidelines    │                                                      ├──────────────────────────────────────────────┤
├──────────────────────────────────────────────┤                                                      │ 8. HistoryCompressionMiddleware              │
│ 4. ToolSchemaMiddleware                      │                                                      │    • Tier 1: Pinned Structural Content       │
│    • Compiles Native Function JSON Schemas   │                                                      │    • Tier 2: Recent Sliding Window Messages  │
│    • Compiles ReAct Sentinel Fallback Schema │                                                      │    • Tier 3: DB-Cached Topic Summaries       │
└──────────────────────────────────────────────┘                                                      └──────────────────────────────────────────────┘
                                                                │
                                                                ▼
                                    ┌────────────────────────────────────────────────────────┐
                                    │                 COMPILED CONTEXT PACKET                │
                                    │ (systemPrompt, userPrompt, history, tools, modelConfig)│
                                    └───────────────────────────┬────────────────────────────┘
                                                                │
                                                                ▼
                                    ┌────────────────────────────────────────────────────────┐
                                    │                Universal Provider Gateway              │
                                    │ (Google Gemini | Anthropic Claude | OpenAI | Ollama)   │
                                    └────────────────────────────────────────────────────────┘
`

---

## 3. Middleware Specifications

### 3.1 Interface Definition

Every middleware implements a standard asynchronous contract:

\\\	ypescript
// packages/server/src/runtime/kernel/contextTypes.ts

export interface ContextBuildContext {
  agent: AgentProfile;
  channelId: string;
  workspaceId: string;
  userInput: string;
  runtimeType: RuntimeType;
  modelConfig: ModelModuleConfig;
  abortSignal: AbortSignal;
  customOverrides?: Record<string, unknown>;
}

export interface MutableContextPacket {
  systemPromptBlocks: Array<{ id: string; priority: number; content: string }>;
  authorityContext?: string;
  taskFileContext?: string;
  memoryPreviewBlock?: string;
  tools: LLMToolDefinition[];
  history: HistoryMessage[];
  userPrompt: string;
  policies: RuntimePolicy;
  metadata: Record<string, unknown>;
}

export interface IContextMiddleware {
  readonly name: string;
  readonly priority: number; // Lower numbers run first (e.g. 10, 20, 30...)
  process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void>;
}
\\\

---

### 3.2 Core Middlewares Breakdown

#### 1. IdentityAuthorityMiddleware (Priority: 10)
- Injects standard agent identity (You are @Raven, a specialist in CrowdOS workspace).
- Injects the strict authority hierarchy prompt according to the agent's tier:
  - **Level 1 (CEO)**: Context on available $ agents, bipolar dispatch authorization.
  - **Level 2 (Manager)**: Superior is $, channel scope, $ worker-supervisor dispatch authorization.
  - **Level 3 (Worker)**: Assigned supervisor name, instructions to execute without architectural divergence.
  - **Level 3 (Supervisor)**: Assigned worker name, quality evaluation criteria, escalation trigger rules.

#### 2. InstructionStackMiddleware (Priority: 20)
- Reads the agent's assigned instruction stack from gent_instruction_stacks.
- Resolves each module in priority order:
  1. Base Persona (instruction_modules.base)
  2. Domain Expertise (instruction_modules.domain)
  3. Output Formatting / Sentinel Protocol (&&FINAL_RESPONSE&&)
  4. Active untime_overrides (appended or replaced based on patch type).

#### 3. SkillContextMiddleware (Priority: 30)
- Queries active skills for the agent (gent_skills link table).
- For each active skill, extracts promptLayer.systemPromptAdditions and promptLayer.executionGuidelines.
- Injects few-shot examples into the system prompt to anchor model reasoning.

#### 4. ToolSchemaMiddleware (Priority: 40)
- Resolves all authorized tools (direct grants from gent_tools + inherited tools from active gent_skills).
- Translates tools into:
  - Native function-calling schemas for provider payloads (equest.tools).
  - Fallback XML descriptions (<call_tool name="...">) if the target provider lacks native tool support.

#### 5. ConstraintSafetyMiddleware (Priority: 50)
- Fetches rules from constraints_modules.
- Appends explicit negative constraints to system prompt:
  \\\
  [SAFETY INVARIANTS]
  - You are strictly prohibited from modifying .env, credentials, or system core files.
  - Never execute unwhitelisted destructive shell commands.
  - Never attempt to bypass authority level restrictions.
  \\\

#### 6. MemoryRetrievalMiddleware (Priority: 60)
- Invokes etrieveMemoryCandidates() from Memories domain.
- Computes multi-lane scores (ecent_episodic, high_importance, unresolved_tensions, mentions, ecency).
- Formats top-10 candidates into the standardized <memory_previews> XML block.
- Prepends memory previews to userPrompt or attaches to packet.memoryPreviewBlock.

#### 7. VisibilityMatrixMiddleware (Priority: 70)
- Queries raw channel messages from the messages table.
- Enforces the agent's memorySharingPolicy:
  - 
one: Only includes messages explicitly mentioning @agent_name.
  - horizontal: Only includes messages from agents at the same authority level + direct mentions.
  - ertical: Only includes messages from $\pm 1$ authority level (direct superior / direct subordinates).
  - ull: Transparent access to all public messages in the channel.

#### 8. HistoryCompressionMiddleware (Priority: 80)
- Implements the 3-Tier token management strategy:
  - **Tier 1 (Pinned)**: System prompt, authority rules, task files (never evicted).
  - **Tier 2 (Sliding Window)**: Last $ visible messages ( = \text{maxRecentMessages}$, default 20–30).
  - **Tier 3 (Compressed Summary)**: If total messages $> \text{compressionThreshold}$, fetches or computes cached summary from compressed_summaries table.

---

## 4. Universal Provider Gateway & Dual Tool Strategy

### 4.1 Fixing Provider History Injection (Google Gemini Bug Fix)

The Google Gemini adapter is upgraded to serialize equest.history properly into Gemini's multi-turn contents array:

\\\	ypescript
// packages/server/src/runtime/providers/GoogleAdapter.ts

private buildBody(config: ModelModuleConfig, request: LLMRequest): unknown {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  // 1. Convert conversational history to Gemini turns
  if (request.history && request.history.length > 0) {
    for (const msg of request.history) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  // 2. Append the current turn user prompt
  contents.push({
    role: 'user',
    parts: [{ text: request.userPrompt }],
  });

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: config.temperature ?? 0.7,
      maxOutputTokens: config.maxOutputTokens ?? 2048,
      topP: config.topP ?? 0.95,
    },
  };

  if (request.systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: request.systemPrompt }],
    };
  }

  // 3. Native Function Calling Schemas (When supported)
  if (request.tools && request.tools.length > 0) {
    body.tools = [{
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    }];
  }

  return body;
}
\\\

---

### 4.2 Dual-Execution ReAct State Machine

The runtime kernel supports both **Provider-Native Tool Calling** and **Sentinel XML Fallback** seamlessly:

`
                          ┌────────────────────────┐
                          │   Raw Model Response   │
                          └───────────┬────────────┘
                                      │
              ┌───────────────────────┴───────────────────────┐
              ▼                                               ▼
┌───────────────────────────┐                   ┌───────────────────────────┐
│ Native Tool Calls Return  │                   │ Sentinel Text Streaming   │
│ (OpenAI / Gemini toolCall)│                   │ (&&FINAL_RESPONSE&& + XML)│
├───────────────────────────┤                   ├───────────────────────────┤
│ • Parse function arguments│                   │ • Stream thoughts live    │
│ • Execute via ToolExecutor│                   │ • Parse <call_tool> regex │
│ • Append tool result turn │                   │ • Demux final user answer │
└───────────────────────────┘                   └───────────────────────────┘
`

---

## 5. Database Schema: Instruction Stacks & Overrides

\\\	ypescript
// packages/server/src/db/schema.ts (Additions for Pillar 2)

import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./schema.js";

// 1. Modular Instruction Blocks
export const instructionModules = pgTable("instruction_modules", {
  id: text("id").primaryKey(),                          // "inst_base_persona", "inst_dba_expert"
  label: text("label").notNull(),
  category: text("category").notNull().default("persona"), // "persona" | "domain" | "format" | "safety"
  base: jsonb("base").<string[]>().notNull().default(sql'[]'::jsonb),
  runtimePatchable: boolean("runtime_patchable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 2. Agent Instruction Stack Links (Ordered composition)
export const agentInstructionStacks = pgTable("agent_instruction_stacks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  instructionModuleId: text("instruction_module_id").notNull().references(() => instructionModules.id, { onDelete: "cascade" }),
  priorityOrder: integer("priority_order").notNull().default(1), // 1 = Base, 2 = Domain, 3 = Formatting
  isEnabled: boolean("is_enabled").notNull().default(true),
});

// 3. Runtime Overrides (Temporary live patches)
export const runtimeOverrides = pgTable("runtime_overrides", {
  id: text("id").primaryKey(),
  targetAgentId: text("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  overrideType: text("override_type").notNull(),        // "instruction_append" | "instruction_replace" | "tool_grant"
  patchPayload: jsonb("patch_payload").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
\\\

---

## 6. Domain Facade Standard: contextGate.ts & untimeGate.ts

\\\	ypescript
// packages/server/src/runtime/contextGate.ts
export { ContextPipelineManager } from "./kernel/ContextPipelineManager.js";
export type { ContextBuildContext, MutableContextPacket, IContextMiddleware } from "./kernel/contextTypes.js";

export const contextGate = {
  assemble: (ctx: ContextBuildContext) => ContextPipelineManager.assemble(ctx),
  registerMiddleware: (mw: IContextMiddleware) => ContextPipelineManager.use(mw),
};
\\\

---

## 7. Implementation Steps & Verification Matrix

- [ ] **Step 2.1**: Implement ContextPipelineManager and the 8 core context middlewares in packages/server/src/runtime/kernel/middlewares/.
- [ ] **Step 2.2**: Update GoogleAdapter.ts, AnthropicAdapter.ts, and OpenAIAdapter.ts to serialize conversational history and native function calling schemas.
- [ ] **Step 2.3**: Unify orphaned MemoryBuilder.ts logic (3-tier compression and visibility matrix) into HistoryCompressionMiddleware and VisibilityMatrixMiddleware.
- [ ] **Step 2.4**: Wire gent_instruction_stacks database table and create CRUD API routes in outes/instructions.ts.
- [ ] **Step 2.5**: Write integration tests verifying prompt layer composition, Google Gemini multi-turn execution, and token sliding window compression.
