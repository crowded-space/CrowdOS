import type { LLMToolDefinition, RawToolCall, HistoryMessage } from '../types.js'

/**
 * Translates between CrowdTool schemas and provider-specific formats.
 * Each provider has its own implementation.
 *
 * Flow:
 *   CrowdTool → compileTools() → Native Tool Schema → LLM
 *   LLM → Native Tool Call → parseToolCalls() → RawToolCall[]
 */
export interface ToolProviderAdapter {
  /** Convert internal tool definitions into the provider's native schema format */
  compileTools(tools: LLMToolDefinition[]): unknown[]

  /** Extract structured tool calls from a raw provider API response */
  parseToolCalls(responseJson: any): RawToolCall[]

  /**
   * Serialize a HistoryMessage with tool data into the provider's message format.
   * Handles assistant-with-tool-calls and tool-result turns.
   */
  serializeToolHistory(msg: HistoryMessage): unknown
}
