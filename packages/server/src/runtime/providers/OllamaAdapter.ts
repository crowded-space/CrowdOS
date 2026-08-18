import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse } from '../types.js'

export class OllamaAdapter implements IProviderAdapter {
  readonly provider = 'ollama'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'llama3'
    const apiKey = config.apiKey || ''

    let endpointUrl = config.endpointUrl || 'http://localhost:11434/v1'
    if (endpointUrl.endsWith('/')) {
      endpointUrl = endpointUrl.slice(0, -1)
    }

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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    if (onChunk) {
      body.stream = true

      let response: Response
      try {
        response = await fetch(`${endpointUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      } catch (err: any) {
        const cause = err?.cause ? ` (Cause: ${String(err.cause)})` : ''
        throw new Error(`[OllamaAdapter] Network error: ${String(err)}${cause} - tried to POST to ${endpointUrl}/chat/completions`)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`[OllamaAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        throw new Error('[OllamaAdapter] Empty response body from stream API')
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
            const contentChunk = json.choices?.[0]?.delta?.content || ''
            if (contentChunk) {
              fullContent += contentChunk
              onChunk({ content: contentChunk })
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
      response = await fetch(`${endpointUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (err: any) {
      const cause = err?.cause ? ` (Cause: ${String(err.cause)})` : ''
      throw new Error(`[OllamaAdapter] Network error: ${String(err)}${cause} - tried to POST to ${endpointUrl}/chat/completions`)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`[OllamaAdapter] API error ${response.status}: ${errorText}`)
    }

    const json = await response.json()
    const content: string = json.choices?.[0]?.message?.content || ''

    if (!content) {
      throw new Error('[OllamaAdapter] Empty response from API')
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
