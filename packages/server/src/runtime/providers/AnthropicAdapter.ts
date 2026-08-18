import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse } from '../types.js'

export class AnthropicAdapter implements IProviderAdapter {
  readonly provider = 'anthropic'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'claude-sonnet-4-20250514'
    const apiKey = config.apiKey || ''

    const messages: Array<{ role: string; content: string }> = []

    if (request.history) {
      for (const msg of request.history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
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

      let response: Response
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new Error(`[AnthropicAdapter] Network error: ${String(err)}`)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`[AnthropicAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        throw new Error('[AnthropicAdapter] Empty response body from stream API')
      }

      let fullContent = ''
      const decoder = new TextDecoder()
      let sseBuffer = ''

      for await (const chunkBytes of reader as any) {
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
            if (json.type === 'content_block_delta' && json.delta?.text) {
              fullContent += json.delta.text
              onChunk({ content: json.delta.text })
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
        }
      }

      const promptTokens = Math.ceil(request.userPrompt.length / 4)
      const completionTokens = Math.ceil(fullContent.length / 4)

      return {
        content: fullContent,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: 'stop',
      }
    }

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new Error(`[AnthropicAdapter] Network error: ${String(err)}`)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`[AnthropicAdapter] API error ${response.status}: ${errorText}`)
    }

    const json = await response.json()
    const content: string = json.content?.[0]?.text || ''

    if (!content) {
      throw new Error('[AnthropicAdapter] Empty response from API')
    }

    const promptTokens: number = json.usage?.input_tokens ?? Math.ceil(request.userPrompt.length / 4)
    const completionTokens: number = json.usage?.output_tokens ?? Math.ceil(content.length / 4)

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: json.stop_reason === 'end_turn' ? 'stop' : 'stop',
    }
  }
}
