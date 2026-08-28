import type { LLMToolDefinition } from './types.js'

// ─── Tool Name (constant, not magic string) ─────────────────────

export const AGENT_COMPLETE = 'agent_complete'

export function isLifecycleTool(name: string): boolean {
  return name === AGENT_COMPLETE
}

// ─── Types ──────────────────────────────────────────────────────

export interface AgentCompleteInput {
  response: string
  // Future extensibility:
  // summary?: string
  // artifacts?: ArtifactRef[]
}

// ─── Tool Definition ───────────────────────────────────────────

export const agentCompleteTool: LLMToolDefinition = {
  name: AGENT_COMPLETE,
  description:
    'Call this tool when you have finished your task and are ready to deliver ' +
    'your final response to the user. The "response" parameter is your final answer. ' +
    'Do NOT call this tool until you have completed all necessary tool calls and reasoning.',
  inputSchema: {
    type: 'object',
    properties: {
      response: {
        type: 'string',
        description: 'Your complete final response to deliver to the user.',
      },
    },
    required: ['response'],
  },
}
