import type { SearchResult, SearchProvider, SearchOptions } from "../search-provider-types.js"

const TAVILY_ENDPOINT = "https://api.tavily.com/search"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_LIMIT = 10

let warnedNoKey = false

function getTavilyKey(): string | undefined {
  const raw = process.env.TAVILY_API_KEY?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

function mapTavilyJson(json: unknown): SearchResult[] {
  const out: SearchResult[] = []
  if (!json || typeof json !== "object") return out
  const obj = json as Record<string, unknown>
  const results = obj.results as unknown[] | undefined
  if (!Array.isArray(results)) return out
  let unparsableTimestamps = 0
  for (const r of results) {
    if (!r || typeof r !== "object") continue
    const rec = r as Record<string, unknown>
    const url = typeof rec.url === "string" ? rec.url : null
    if (!url) continue
    const title = typeof rec.title === "string" ? rec.title : url
    const snippet = typeof rec.content === "string" ? rec.content : typeof rec.snippet === "string" ? rec.snippet : ""
    let timestamp: string | undefined
    const raw = (rec.published_date as string | undefined) ?? (rec.publishedDate as string | undefined) ?? (rec.date as string | undefined)
    if (typeof raw === "string" && raw) {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) timestamp = new Date(parsed).toISOString()
      else unparsableTimestamps++
    }
    out.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 2000), timestamp, source: "tavily" })
  }
  if (unparsableTimestamps > 0) {
    console.warn(`[SearchProviders:tavily] ${unparsableTimestamps} result timestamp(s) unparseable — dropped, rows keep no freshness signal`)
  }
  return out
}

export const tavilyProvider: SearchProvider = {
  name: "tavily",
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getTavilyKey()
    if (!apiKey) {
      if (!warnedNoKey) {
        warnedNoKey = true
        console.warn("[SearchProviders:tavily] Tavily search unavailable — returning [] (graceful fallback)")
      }
      return []
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 20)
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Tavily search timeout")), timeoutMs)
    const callerSignal = opts?.signal
    const onCallerAbort = (): void => controller.abort(callerSignal!.reason)
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    }
    let res: Response
    try {
      const body = JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_images: false,
      })
      res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("abort") || msg.includes("timeout")) {
        console.warn(`[SearchProviders:tavily] fetch aborted/timeout for "${query.slice(0, 80)}": ${msg}`)
      } else {
        console.warn(`[SearchProviders:tavily] fetch failed: ${msg}`)
      }
      throw err instanceof Error ? err : new Error(msg)
    } finally {
      clearTimeout(timeoutId)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    }
    // Failures after fetch throw so searchProviderService can count them
    // (empty [] stays reserved for genuine empty / missing key).
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (res.status === 429) {
        // ponytail: no 429 retry, add backoff if throttling observed
        const retryAfter = res.headers.get("Retry-After")
        console.warn(`[SearchProviders:tavily] HTTP 429 rate-limited${retryAfter ? `, Retry-After: ${retryAfter}` : ""}: ${text.slice(0, 300)}`)
        throw new Error(`HTTP 429 rate-limited${retryAfter ? `, Retry-After: ${retryAfter}` : ""}`)
      }
      console.warn(`[SearchProviders:tavily] HTTP ${res.status}: ${text.slice(0, 300)}`)
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json().catch(() => null)
    if (json === null) {
      console.warn(`[SearchProviders:tavily] HTTP 200 but unparseable JSON response`)
      throw new Error("HTTP 200 but unparseable JSON")
    }
    return mapTavilyJson(json).slice(0, limit)
  },
}

export function __testMapTavilyJson(json: unknown): SearchResult[] {
  return mapTavilyJson(json)
}
