import type { IProviderAdapter, ModelModuleConfig, LLMRequest, LLMResponse, RawToolCall } from '../types.js'
import { isProviderError } from './providerErrors.js'
import { providerFetch, type GuardedProviderCall } from './providerHttp.js'

export class GoogleAdapter implements IProviderAdapter {
  readonly provider = 'google'
  readonly supportsStreaming = true
  readonly supportsTools = true

  async call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void,
    options?: { signal?: AbortSignal }
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

      let guarded: GuardedProviderCall
      try {
        guarded = await providerFetch(
          url,
          { method: 'POST', headers, body: JSON.stringify(body) },
          { callerSignal: options?.signal, provider: 'google' }
        )
      } catch (err) {
        if (isProviderError(err)) throw err
        throw new Error(`[GoogleAdapter] Network error: ${String(err)}`)
      }
      const response = guarded.response

      if (!response.ok) {
        const errorText = await guarded.text()
        throw new Error(`[GoogleAdapter] API error ${response.status}: ${errorText}`)
      }

      const reader = response.body
      if (!reader) {
        guarded.finish()
        throw new Error('[GoogleAdapter] Empty response body from stream API')
      }

      let fullThoughts = ''
      let fullContent = ''
      const streamToolCalls: RawToolCall[] = []
      const decoder = new TextDecoder()
      let sseBuffer = ''
      let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

      for await (const chunkBytes of guarded.stream(reader)) {
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
            // Real token accounting: usageMetadata arrives per chunk (final counts on last)
            const um = json.usageMetadata
            if (um && typeof um.promptTokenCount === 'number') {
              streamUsage = {
                promptTokens: um.promptTokenCount,
                completionTokens: typeof um.candidatesTokenCount === 'number' ? um.candidatesTokenCount : 0,
                totalTokens: typeof um.totalTokenCount === 'number' ? um.totalTokenCount : (um.promptTokenCount + (um.candidatesTokenCount || 0)),
              }
            }
            const parts = json.candidates?.[0]?.content?.parts
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                if (part.thought) {
                  fullThoughts += part.text
                  onChunk({ content: part.text, isThoughts: true })
                } else if (part.text) {
                  fullContent += part.text
                  onChunk({ content: part.text, isThoughts: false })
                } else if (part.functionCall) {
                  streamToolCalls.push({
                    id: `call_${Date.now()}_${streamToolCalls.length}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args || {},
                  })
                }
              }
            }
          } catch {
            // ignore JSON parse errors for incomplete chunk lines
          }
        }
      }

      return this.finalize(fullContent, fullThoughts, streamToolCalls.length > 0 ? streamToolCalls : undefined, streamToolCalls.length > 0 ? 'tool_use' : 'stop', streamUsage)
    }

    let guarded: GuardedProviderCall
    try {
      guarded = await providerFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        { callerSignal: options?.signal, provider: 'google' }
      )
    } catch (err) {
      if (isProviderError(err)) throw err
      throw new Error(`[GoogleAdapter] Network error: ${String(err)}`)
    }

    if (!guarded.response.ok) {
      const errorText = await guarded.text()
      throw new Error(`[GoogleAdapter] API error ${guarded.response.status}: ${errorText}`)
    }

    const json = await guarded.json() as any
    const parts = json.candidates?.[0]?.content?.parts || []
    let rawText = ''
    const toolCalls: RawToolCall[] = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.text) rawText += part.text
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${i}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        })
      }
    }

    if (!rawText && toolCalls.length === 0) {
      throw new Error('[GoogleAdapter] Empty response from API')
    }

    const isGemma = modelName.toLowerCase().includes('gemma')
    let contentStr = rawText
    let thoughts: string | undefined

    if (isGemma && rawText) {
      const parsed = this.parseGemmaThoughts(rawText)
      contentStr = parsed.answer
      thoughts = parsed.thoughts || undefined
    }

    const um = json.usageMetadata
    const usage = um && typeof um.promptTokenCount === 'number'
      ? {
          promptTokens: um.promptTokenCount,
          completionTokens: typeof um.candidatesTokenCount === 'number' ? um.candidatesTokenCount : 0,
          totalTokens: typeof um.totalTokenCount === 'number' ? um.totalTokenCount : (um.promptTokenCount + (um.candidatesTokenCount || 0)),
        }
      : undefined

    return this.finalize(contentStr, thoughts, toolCalls.length > 0 ? toolCalls : undefined, toolCalls.length > 0 ? 'tool_use' : 'stop', usage, request, rawText)
  }

  /** Prefer provider-reported usage; fall back to the char/4 estimate. */
  private finalize(
    content: string,
    thoughts: string | undefined,
    toolCalls: RawToolCall[] | undefined,
    finishReason: LLMResponse['finishReason'],
    realUsage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    request?: LLMRequest,
    rawText?: string
  ): LLMResponse {
    let promptTokens: number
    let completionTokens: number

    if (realUsage) {
      promptTokens = realUsage.promptTokens
      completionTokens = realUsage.completionTokens
    } else {
      promptTokens = Math.ceil(((request?.systemPrompt || '') + (request?.userPrompt || '')).length / 4)
      completionTokens = Math.ceil(((thoughts || '') + (rawText !== undefined ? rawText : content)).length / 4)
    }

    return {
      content,
      thoughts: thoughts || undefined,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: realUsage?.totalTokens ?? (promptTokens + completionTokens),
      },
      finishReason,
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
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
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
    const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = []

    // 1. Serialize conversational history into multi-turn Gemini turns
    if (request.history && request.history.length > 0) {
      for (const msg of request.history) {
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
          const parts: any[] = []
          if (msg.content) parts.push({ text: msg.content })
          for (const tc of msg.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.input } })
          }
          contents.push({ role: 'model', parts })
        } else if (msg.role === 'tool') {
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: msg.toolName || "tool", response: { result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) } } }],
          })
        } else {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          })
        }
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