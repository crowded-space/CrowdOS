import type { SearchResult, SearchProvider, SearchOptions } from "../searchProviderTypes.js"

const TAVILY_ENDPOINT = "https://api.tavily.com/search"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_LIMIT = 10

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
      else timestamp = raw
    }
    out.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 2000), timestamp, source: "tavily" })
  }
  return out
}

export const tavilyProvider: SearchProvider = {
  name: "tavily",
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getTavilyKey()
    if (!apiKey) {
      console.warn("[SearchProviders:tavily] Tavily search unavailable — returning [] (graceful fallback)")
      return []
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 20)
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Tavily search timeout")), timeoutMs)
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason)
      else opts.signal.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true })
    }
    try {
      const body = JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_images: false,
      })
      const res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        console.warn(`[SearchProviders:tavily] HTTP ${res.status}: ${text.slice(0, 300)}`)
        return []
      }
      const json = await res.json().catch(() => null)
      const results = mapTavilyJson(json).slice(0, limit)
      return results
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("abort") || msg.includes("timeout")) {
        console.warn(`[SearchProviders:tavily] fetch aborted/timeout for "${query.slice(0, 80)}": ${msg}`)
      } else {
        console.warn(`[SearchProviders:tavily] fetch failed: ${msg}`)
      }
      return []
    } finally {
      clearTimeout(timeoutId)
    }
  },
}

export function __testMapTavilyJson(json: unknown): SearchResult[] {
  return mapTavilyJson(json)
}
