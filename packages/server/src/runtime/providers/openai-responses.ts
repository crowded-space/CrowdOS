import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse, RawToolCall } from '../types.js'
import { isProviderError } from './provider-errors.js'
import { providerFetch, type GuardedProviderCall } from './provider-http.js'

/**
 * OpenAI Responses wire protocol (POST {base}/responses), used when a model
 * module selects `apiEndpoint: "openai-responses"`. Honored by the openai and
 * custom providers ("OpenAI-Completion" and the native protocols stay their
 * adapters' existing behavior); anything else that names this endpoint speaks
 * it against `config.endpointUrl` too.
 */

export function usesResponsesProtocol(config: Pick<ModelModuleConfig, 'apiEndpoint'>): boolean {
  return config.apiEndpoint === 'openai-responses'
}

/** 'none' means provider default: no reasoning knob is sent at all. */
function reasoningEffort(config: ModelModuleConfig): string | undefined {
  const level = config.thinkingLevel
  return level && level !== 'none' ? level : undefined
}

export async function callOpenAIResponses(
  config: ModelModuleConfig,
  request: LLMRequest,
  onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void,
  options?: { signal?: AbortSignal }
): Promise<LLMResponse> {
  const modelName = config.modelName
  if (!modelName) {
    throw new Error('[ResponsesAdapter] Missing model name. Bind the agent to a model module with an explicit model.')
  }
  const apiKey = config.apiKey
    || (config.provider === 'custom' ? process.env.CUSTOM_API_KEY : process.env.OPENAI_API_KEY)
    || ''
  const base = (config.endpointUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')

  const input: any[] = []
  if (request.history) {
    for (const msg of request.history) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        if (msg.content) input.push({ role: 'assistant', content: msg.content })
        for (const tc of msg.toolCalls) {
          input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) })
        }
      } else if (msg.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: msg.toolCallId || 'call_0', output: msg.content })
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        input.push({ role: msg.role, content: msg.content })
      }
    }
  }
  input.push({ role: 'user', content: request.userPrompt })

  const effort = reasoningEffort(config)
  const body: Record<string, unknown> = {
    model: modelName,
    input,
    max_output_tokens: config.maxOutputTokens ?? 2048,
  }
  if (request.systemPrompt) {
    body.instructions = request.systemPrompt
  }
  // Reasoning models reject `temperature` (the API pins temperature to 1 internally),
  // so the knob is only sent while thinking is off.
  if (!effort && config.temperature !== undefined) {
    body.temperature = config.temperature
  }
  if (effort) {
    body.reasoning = { effort }
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || (t as any).parameters,
    }))
  }

  if (onChunk) {
    body.stream = true
  }

  let guarded: GuardedProviderCall
  try {
    guarded = await providerFetch(
      `${base}/responses`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { callerSignal: options?.signal, provider: 'openai-responses' }
    )
  } catch (err) {
    if (isProviderError(err)) throw err
    throw new Error(`[ResponsesAdapter] Network error: ${String(err)}`)
  }

  if (!guarded.response.ok) {
    const errorText = await guarded.text()
    throw new Error(`[ResponsesAdapter] API error ${guarded.response.status}: ${errorText}`)
  }

  if (!onChunk) {
    const json = await guarded.json() as any
    return parseResponsesResponse(json, request)
  }

  const reader = guarded.response.body
  if (!reader) {
    guarded.finish()
    throw new Error('[ResponsesAdapter] Empty response body from stream API')
  }

  let fullContent = ''
  let fullThoughts = ''
  const decoder = new TextDecoder()
  let sseBuffer = ''
  const callItems = new Map<string, { name: string; argsJson: string }>()
  const toolCallAccumulator: RawToolCall[] = []
  let streamUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
  let streamFinish = ''

  for await (const chunkBytes of guarded.stream(reader)) {
    sseBuffer += decoder.decode(chunkBytes, { stream: true })
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const dataStr = trimmed.slice(6).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      let json: any
      try {
        json = JSON.parse(dataStr)
      } catch {
        continue
      }
      // Real token accounting: usage rides the terminal response events.
      if (json.response?.usage && typeof json.response.usage.input_tokens === 'number') {
        const u = json.response.usage
        streamUsage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens }
      }
      if (json.response?.status) streamFinish = json.response.status

      switch (json.type) {
        case 'response.output_item.added':
          if (json.item?.type === 'function_call') {
            callItems.set(json.item.item_id ?? json.item.id ?? '', {
              name: json.item.name || '',
              argsJson: json.item.arguments || '',
            })
          }
          break
        case 'response.output_text.delta':
          if (json.delta) {
            fullContent += json.delta
            onChunk({ content: json.delta, isThoughts: false })
          }
          break
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta':
          if (json.delta) {
            fullThoughts += json.delta
            onChunk({ content: json.delta, isThoughts: true })
          }
          break
        case 'response.function_call_arguments.delta': {
          const entry = callItems.get(json.item_id ?? '')
          if (entry) entry.argsJson += json.delta || ''
          break
        }
        case 'response.function_call_arguments.done': {
          const entry = callItems.get(json.item_id ?? '')
          if (entry) entry.argsJson = json.arguments || entry.argsJson
          break
        }
        case 'response.failed':
        case 'response.error':
          if (json.response?.error || json.error) {
            throw new Error(`[ResponsesAdapter] API error: ${JSON.stringify(json.response?.error || json.error)}`)
          }
          break
        default:
          break
      }
    }
  }

  for (const entry of callItems.values()) {
    try {
      toolCallAccumulator.push({ id: 'call_' + toolCallAccumulator.length, name: entry.name, input: JSON.parse(entry.argsJson || '{}') })
    } catch {
      toolCallAccumulator.push({ id: 'call_' + toolCallAccumulator.length, name: entry.name, input: {} })
    }
  }

  const promptTokens: number = streamUsage?.inputTokens ?? estimateTokens(request.systemPrompt + request.userPrompt)
  const completionTokens: number = streamUsage?.outputTokens
    ?? estimateTokens(fullThoughts + fullContent)

  return {
    content: fullContent,
    thoughts: fullThoughts || undefined,
    toolCalls: toolCallAccumulator.length > 0 ? toolCallAccumulator : undefined,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: streamUsage?.totalTokens ?? (promptTokens + completionTokens),
    },
    finishReason: toolCallAccumulator.length > 0 ? 'tool_use' : 'stop',
  }
}

/** ponytail: stream needs line access without picking internals — keeps the guard contract intact. */
const response = {
  bodyOf: (guarded: GuardedProviderCall) => guarded.response.body,
}

export function parseResponsesResponse(json: any, request: LLMRequest): LLMResponse {
  const output: any[] = json.output || []
  let content = ''
  let thoughts = ''
  const toolCalls: RawToolCall[] = []

  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) content += part.text
        else if (part.type === 'refusal' && part.refusal) content += part.refusal
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s?.text) thoughts += s.text
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || 'call_' + toolCalls.length,
        name: item.name,
        input: (() => { try { return JSON.parse(item.arguments || '{}') } catch { return {} } })(),
      })
    }
  }

  if (!content && toolCalls.length === 0) {
    throw new Error('[ResponsesAdapter] Empty response from API')
  }

  const promptTokens: number = json.usage?.input_tokens ?? estimateTokens(request.systemPrompt + request.userPrompt)
  const completionTokens: number = json.usage?.output_tokens ?? estimateTokens(thoughts + content)

  return {
    content,
    thoughts: thoughts || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: json.usage?.total_tokens ?? (promptTokens + completionTokens),
    },
    finishReason: toolCalls.length > 0 ? 'tool_use' : (json.status === 'incomplete' ? 'max_tokens' : 'stop'),
  }
}

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4)
}
