import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse } from '../types.js'

export class GoogleAdapter implements IProviderAdapter {
  readonly provider = 'google'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void
  ): Promise<LLMResponse> {
    const modelName = config.modelName || 'gemini-2.0-flash'
    this.validateModel(modelName)

    let { url, headers } = this.compileEndpoint(config)
    const body = this.buildBody(config, request)

    if (onChunk) {
      url = url.replace(':generateContent', ':streamGenerateContent')
      if (url.includes('?')) {
        url += '&alt=sse'
      } else {
        url += '?alt=sse'
      }

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new Error(`[GoogleAdapter] Network error: ${String(err)}`)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`[GoogleAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        throw new Error('[GoogleAdapter] Empty response body from stream API')
      }

      let fullThoughts = ''
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
          if (dataStr === '[DONE]') continue
          try {
            const json = JSON.parse(dataStr)
            const parts = json.candidates?.[0]?.content?.parts
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                if (part.thought) {
                  fullThoughts += part.text
                  onChunk({ content: part.text, isThoughts: true })
                } else if (part.text) {
                  fullContent += part.text
                  onChunk({ content: part.text })
                }
              }
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
        }
      }

      const promptTokens = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4)
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
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new Error(`[GoogleAdapter] Network error: ${String(err)}`)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`[GoogleAdapter] API error ${response.status}: ${errorText}`)
    }

    const json = await response.json()
    const rawText: string = json.candidates?.[0]?.content?.parts?.[0]?.text || ''

    if (!rawText) {
      throw new Error('[GoogleAdapter] Empty response from API')
    }

    const isGemma = modelName.toLowerCase().includes('gemma')
    let content = rawText
    let thoughts: string | undefined

    if (isGemma) {
      const parsed = this.parseGemmaThoughts(rawText)
      content = parsed.answer
      thoughts = parsed.thoughts || undefined
    }

    const promptTokens = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4)
    const completionTokens = Math.ceil(rawText.length / 4)

    return {
      content,
      thoughts,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: 'stop',
    }
  }

  private validateModel(modelName: string): void {
    const lower = modelName.toLowerCase()
    if (lower.includes('gemma') && !lower.includes('gemma-4')) {
      throw new Error(
        `[GoogleAdapter] Only Gemma 4 is supported. Got: "${modelName}". Use a gemma-4-* model.`
      )
    }
  }

  private compileEndpoint(config: ModelModuleConfig): { url: string; headers: Record<string, string> } {
    const modelName = config.modelName || 'gemini-2.0-flash'
    const apiKey = config.apiKey || ''
    const endpointUrl = config.endpointUrl || ''
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (endpointUrl.includes('aiplatform.googleapis.com')) {
      const regionMatch = endpointUrl.match(/https:\/\/([\w-]+)-aiplatform/)
      const projectMatch = endpointUrl.match(/\/projects\/([\w-]+)\//)
      const region = regionMatch?.[1] ?? 'us-central1'
      const projectId = projectMatch?.[1] ?? 'crowdos-project'
      const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelName}:generateContent`
      headers['Authorization'] = `Bearer ${apiKey}`
      return { url, headers }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`
    return { url, headers }
  }

  private buildBody(config: ModelModuleConfig, request: LLMRequest): unknown {
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []

    // 1. Serialize conversational history into multi-turn Gemini turns
    if (request.history && request.history.length > 0) {
      for (const msg of request.history) {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        })
      }
    }

    // 2. Append current user prompt
    contents.push({
      role: 'user',
      parts: [{ text: request.userPrompt }],
    })

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: config.temperature ?? 0.7,
        maxOutputTokens: config.maxOutputTokens ?? 2048,
        topP: config.topP ?? 0.95,
      },
    }

    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || (t as any).parameters,
          })),
        },
      ]
    }

    return body
  }

  private parseGemmaThoughts(text: string): { thoughts: string; answer: string } {
    const delimiters = [
      { start: '<|channel>thought', end: '<channel|>' },
      { start: '<|think|>', end: '</|think|>' },
      { start: '<thought>', end: '</thought>' },
    ]

    let thoughts = ''
    let answer = text

    for (const delim of delimiters) {
      const startIndex = answer.indexOf(delim.start)
      if (startIndex !== -1) {
        const endIndex = answer.indexOf(delim.end, startIndex + delim.start.length)
        if (endIndex !== -1) {
          thoughts = answer.slice(startIndex + delim.start.length, endIndex).trim()
          answer = (answer.slice(0, startIndex) + answer.slice(endIndex + delim.end.length)).trim()
        }
      }
    }

    return { thoughts, answer }
  }
}
