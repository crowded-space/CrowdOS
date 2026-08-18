import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse } from '../types.js'

export class OpenAIAdapter implements IProviderAdapter {
  readonly provider = 'openai'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'gpt-4o'
    const apiKey = config.apiKey || ''
    const endpointUrl = config.endpointUrl || 'https://api.openai.com/v1'

    const messages: Array<{ role: string; content: string }> = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

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

    if (onChunk) {
      body.stream = true

      let response: Response
      try {
        response = await fetch(`${endpointUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new Error(`[OpenAIAdapter] Network error: ${String(err)}`)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`[OpenAIAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        throw new Error('[OpenAIAdapter] Empty response body from stream API')
      }

      let fullContent = ''
      let fullThoughts = ''
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
          if (dataStr === '[DONE]') continue
          try {
            const json = JSON.parse(dataStr)
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
                onChunk({ content: contentChunk })
              }
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
        }
      }

      const promptTokens = Math.ceil(request.userPrompt.length / 4)
      const completionTokens = Math.ceil((fullThoughts.length + fullContent.length) / 4)

      return {
        content: fullContent,
        thoughts: fullThoughts || undefined,
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
      response = await fetch(`${endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new Error(`[OpenAIAdapter] Network error: ${String(err)}`)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`[OpenAIAdapter] API error ${response.status}: ${errorText}`)
    }

    const json = await response.json()
    const content: string = json.choices?.[0]?.message?.content || ''

    if (!content) {
      throw new Error('[OpenAIAdapter] Empty response from API')
    }

    const promptTokens: number = json.usage?.prompt_tokens ?? Math.ceil(request.userPrompt.length / 4)
    const completionTokens: number = json.usage?.completion_tokens ?? Math.ceil(content.length / 4)

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: 'stop',
    }
  }
}
