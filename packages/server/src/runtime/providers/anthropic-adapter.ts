import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse, RawToolCall } from '../types.js'
import { isProviderError } from './provider-errors.js'
import { providerFetch, type GuardedProviderCall } from './provider-http.js'

export class AnthropicAdapter implements IProviderAdapter {
  readonly provider = 'anthropic'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'claude-sonnet-4-20250514'
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || ''

    const messages: Array<{ role: string; content: any }> = []

    if (request.history) {
      for (const msg of request.history) {
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
          // Assistant turn with tool calls: multi-block content
          const contentBlocks: any[] = []
          if (msg.content) contentBlocks.push({ type: 'text', text: msg.content })
          for (const tc of msg.toolCalls) {
            contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
          }
          messages.push({ role: 'assistant', content: contentBlocks })
        } else if (msg.role === 'tool') {
          // Tool result: Anthropic expects this as user turn with tool_result content block
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: msg.toolCallId || "call_0", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }]
          })
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content })
        }
      }
    }

    messages.push({ role: 'user', content: request.userPrompt })

    const body: Record<string, unknown> = {
      model: modelName,
      max_tokens: config.maxOutputTokens ?? 2048,
      messages,
    }

    if (request.systemPrompt) {
      body.system = request.systemPrompt
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema || (t as any).parameters,
      }))
    }

    if (onChunk) {
      body.stream = true

      let guarded: GuardedProviderCall
      try {
        guarded = await providerFetch(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
          },
          { callerSignal: options?.signal, provider: 'anthropic' }
        )
      } catch (err) {
        if (isProviderError(err)) throw err
        throw new Error(`[AnthropicAdapter] Network error: ${String(err)}`)
      }
      const response = guarded.response

      if (!response.ok) {
        const errorText = await guarded.text()
        throw new Error(`[AnthropicAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        guarded.finish()
        throw new Error('[AnthropicAdapter] Empty response body from stream API')
      }

      let fullContent = ''
      let fullThoughts = ''
      const decoder = new TextDecoder()
      let sseBuffer = ''
      const toolBlockAccumulator = new Map<number, { id: string; name: string; argsJson: string }>()
      let streamFinishReason: string = 'stop'
      let streamUsage: { inputTokens?: number; outputTokens?: number } = {}

      for await (const chunkBytes of guarded.stream(reader)) {
        sseBuffer += decoder.decode(chunkBytes, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const dataStr = trimmed.slice(6).trim()
          if (!dataStr) continue
          try {
            const json = JSON.parse(dataStr)
            // Real token accounting: input on message_start, output on message_delta
            if (json.type === 'message_start' && json.message?.usage) {
              streamUsage.inputTokens = json.message.usage.input_tokens
              if (json.message.usage.output_tokens) streamUsage.outputTokens = json.message.usage.output_tokens
            } else if (json.type === 'message_delta' && json.usage?.output_tokens !== undefined) {
              streamUsage.outputTokens = json.usage.output_tokens
            }
            if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
              toolBlockAccumulator.set(json.index, {
                id: json.content_block.id,
                name: json.content_block.name,
                argsJson: ''
              })
            } else if (json.type === 'content_block_delta') {
              if (json.delta?.thinking) {
                fullThoughts += json.delta.thinking
                onChunk({ content: json.delta.thinking, isThoughts: true })
              } else if (json.delta?.text) {
                fullContent += json.delta.text
                onChunk({ content: json.delta.text, isThoughts: false })
              } else if (json.delta?.type === 'input_json_delta') {
                const entry = toolBlockAccumulator.get(json.index)
                if (entry) {
                  entry.argsJson += json.delta.partial_json
                }
              }
            } else if (json.type === 'message_delta') {
              if (json.delta?.stop_reason) {
                streamFinishReason = json.delta.stop_reason
              }
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
        }
      }

      const streamToolCalls: RawToolCall[] = []
      for (const entry of toolBlockAccumulator.values()) {
        try {
          streamToolCalls.push({ id: entry.id, name: entry.name, input: JSON.parse(entry.argsJson || '{}') })
        } catch {
          streamToolCalls.push({ id: entry.id, name: entry.name, input: {} })
        }
      }

      const promptTokens: number = streamUsage.inputTokens ?? Math.ceil(request.userPrompt.length / 4)
      const completionTokens: number = streamUsage.outputTokens ?? Math.ceil((fullThoughts.length + fullContent.length) / 4)

      return {
        content: fullContent,
        thoughts: fullThoughts || undefined,
        toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: streamFinishReason === 'tool_use' ? 'tool_use' : 'stop',
      }
    }

    let guarded: GuardedProviderCall
    try {
      guarded = await providerFetch(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        },
        { callerSignal: options?.signal, provider: 'anthropic' }
      )
    } catch (err) {
      if (isProviderError(err)) throw err
      throw new Error(`[AnthropicAdapter] Network error: ${String(err)}`)
    }

    if (!guarded.response.ok) {
      const errorText = await guarded.text()
      throw new Error(`[AnthropicAdapter] API error ${guarded.response.status}: ${errorText}`)
    }

    const json = await guarded.json() as any
    
    let content = ''
    const toolCalls: RawToolCall[] = []

    if (json.content && Array.isArray(json.content)) {
      for (const block of json.content) {
        if (block.type === 'text') {
          content += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: block.input })
        }
      }
    }

    if (!content && toolCalls.length === 0) {
      throw new Error('[AnthropicAdapter] Empty response from API')
    }

    const promptTokens: number = json.usage?.input_tokens ?? Math.ceil(request.userPrompt.length / 4)
    const completionTokens: number = json.usage?.output_tokens ?? Math.ceil(content.length / 4)

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: json.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
    }
  }
}
