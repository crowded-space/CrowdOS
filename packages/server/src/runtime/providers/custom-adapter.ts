import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse , RawToolCall} from '../types.js'
import { isProviderError } from './provider-errors.js'
import { providerFetch, type GuardedProviderCall } from './provider-http.js'

export class CustomAdapter implements IProviderAdapter {
  readonly provider = 'custom'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'custom-model'
    const apiKey = config.apiKey || process.env.CUSTOM_API_KEY || ''

    let endpointUrl = config.endpointUrl || 'http://localhost:8080/v1'
    if (endpointUrl.endsWith('/')) {
      endpointUrl = endpointUrl.slice(0, -1)
    }

    const messages: any[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

    if (request.history) {
      for (const msg of request.history) {
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
          messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          } as any)
        } else if (msg.role === 'tool') {
          messages.push({
            role: 'tool',
            tool_call_id: msg.toolCallId || "call_0",
            content: msg.content,
          } as any)
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content })
        }
      }
    }

    messages.push({ role: 'user', content: request.userPrompt })

    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      max_tokens: config.maxOutputTokens ?? 2048,
      temperature: config.temperature ?? 0.7,
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || (t as any).parameters,
        },
      }))
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    if (onChunk) {
      body.stream = true

      let guarded: GuardedProviderCall
      try {
        guarded = await providerFetch(
          `${endpointUrl}/chat/completions`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          { callerSignal: options?.signal, provider: 'custom' }
        )
      } catch (err: any) {
        if (isProviderError(err)) throw err
        const cause = err?.cause ? ` (Cause: ${String(err.cause)})` : ''
        throw new Error(`[CustomAdapter] Network error: ${String(err)}${cause} - tried to POST to ${endpointUrl}/chat/completions`)
      }
      const response = guarded.response

      if (!response.ok) {
        const errorText = await guarded.text()
        throw new Error(`[CustomAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        guarded.finish()
        throw new Error('[CustomAdapter] Empty response body from stream API')
      }

      let fullContent = ''
      let fullThoughts = ''
      const decoder = new TextDecoder()
      let sseBuffer = ''

      const toolCallAccumulator = new Map<number, { id: string; name: string; argsJson: string }>()
      let streamFinishReason: string = 'stop'
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined

      for await (const chunkBytes of guarded.stream(reader)) {
        sseBuffer += decoder.decode(chunkBytes, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const dataStr = trimmed.slice(6).trim()
          if (dataStr === '[DONE]') continue
          if (!dataStr) continue
          try {
            const json = JSON.parse(dataStr)
            // Real token accounting when the server reports usage chunks
            if (json.usage && typeof json.usage.prompt_tokens === 'number') {
              streamUsage = json.usage
            }
            const delta = json.choices?.[0]?.delta
            if (delta) {
              const contentChunk = delta.content || ''
              const reasoningChunk = delta.reasoning_content || delta.reasoning || delta.thinking || ''

              if (reasoningChunk) {
                fullThoughts += reasoningChunk
                onChunk({ content: reasoningChunk, isThoughts: true })
              }
              if (contentChunk) {
                fullContent += contentChunk
                onChunk({ content: contentChunk, isThoughts: false })
              }

              // Handle streamed tool calls
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  if (!toolCallAccumulator.has(idx)) {
                    toolCallAccumulator.set(idx, { id: tc.id || '', name: tc.function?.name || '', argsJson: '' })
                  }
                  const entry = toolCallAccumulator.get(idx)!
                  if (tc.id) entry.id = tc.id
                  if (tc.function?.name) entry.name = tc.function.name
                  if (tc.function?.arguments) entry.argsJson += tc.function.arguments
                }
              }
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
          // Capture finish reason
          try {
            const json = JSON.parse(dataStr)
            if (json.choices?.[0]?.finish_reason) {
              streamFinishReason = json.choices[0].finish_reason
            }
          } catch {}
        }
      }

      const streamToolCalls: RawToolCall[] = []
      for (const entry of toolCallAccumulator.values()) {
        try {
          streamToolCalls.push({ id: entry.id, name: entry.name, input: JSON.parse(entry.argsJson || '{}') })
        } catch {
          streamToolCalls.push({ id: entry.id, name: entry.name, input: {} })
        }
      }

      const promptTokens: number = streamUsage?.prompt_tokens ?? Math.ceil(request.userPrompt.length / 4)
      const completionTokens: number = streamUsage?.completion_tokens ?? Math.ceil((fullThoughts.length + fullContent.length) / 4)

      return {
        content: fullContent,
        thoughts: fullThoughts || undefined,
        toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: streamUsage?.total_tokens ?? (promptTokens + completionTokens),
        },
        finishReason: streamFinishReason === 'tool_calls' ? 'tool_use' : 'stop',
      }
    }

    let guarded: GuardedProviderCall
    try {
      guarded = await providerFetch(
        `${endpointUrl}/chat/completions`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        { callerSignal: options?.signal, provider: 'custom' }
      )
    } catch (err: any) {
      if (isProviderError(err)) throw err
      const cause = err?.cause ? ` (Cause: ${String(err.cause)})` : ''
      throw new Error(`[CustomAdapter] Network error: ${String(err)}${cause} - tried to POST to ${endpointUrl}/chat/completions`)
    }

    if (!guarded.response.ok) {
      const errorText = await guarded.text()
      throw new Error(`[CustomAdapter] API error ${guarded.response.status}: ${errorText}`)
    }

    const json = await guarded.json() as any
    const message = json.choices?.[0]?.message
    const content: string = message?.content || ''
    const rawToolCalls = message?.tool_calls as any[] | undefined
    const toolCalls: RawToolCall[] = (rawToolCalls || []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      // ponytail: IIFE not helper, one malformed args must not kill the turn
      input: (() => { try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} } })(),
    }))

    if (!content && toolCalls.length === 0) {
      throw new Error('[CustomAdapter] Empty response from API')
    }

    const promptTokens: number = json.usage?.prompt_tokens ?? Math.ceil(request.userPrompt.length / 4)
    const completionTokens: number = json.usage?.completion_tokens ?? Math.ceil(content.length / 4)

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: json.choices?.[0]?.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
    }
  }
}
