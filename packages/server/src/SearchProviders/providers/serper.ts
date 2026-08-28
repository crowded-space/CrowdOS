import type { SearchResult, SearchProvider, SearchOptions } from "../searchProviderTypes.js"

const SERPER_ENDPOINT = "https://google.serper.dev/search"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_LIMIT = 10

function getSerperKey(): string | undefined {
  const raw = process.env.SERPER_API_KEY?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

function mapSerperJson(json: unknown): SearchResult[] {
  const out: SearchResult[] = []
  if (!json || typeof json !== "object") return out
  const obj = json as Record<string, unknown>
  const organic = (obj.organic as unknown[] | undefined) ?? (obj.results as unknown[] | undefined)
  if (!Array.isArray(organic)) return out
  for (const r of organic) {
    if (!r || typeof r !== "object") continue
    const rec = r as Record<string, unknown>
    const url = typeof rec.link === "string" ? rec.link : typeof rec.url === "string" ? rec.url : null
    if (!url) continue
    const title = typeof rec.title === "string" ? rec.title : url
    const snippet = typeof rec.snippet === "string" ? rec.snippet : typeof rec.description === "string" ? rec.description : ""
    let timestamp: string | undefined
    const raw = (rec.date as string | undefined) ?? (rec.publishedDate as string | undefined) ?? (rec.published_date as string | undefined)
    if (typeof raw === "string" && raw) {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) timestamp = new Date(parsed).toISOString()
      else timestamp = raw
    }
    out.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 2000), timestamp, source: "serper" })
  }
  return out
}

export const serperProvider: SearchProvider = {
  name: "serper",
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getSerperKey()
    if (!apiKey) {
      console.warn("[SearchProviders:serper] Serper search unavailable — returning [] (graceful fallback)")
      return []
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 20)
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Serper search timeout")), timeoutMs)
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason)
      else opts.signal.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true })
    }
    try {
      const body = JSON.stringify({ q: query, num: limit })
      const res = await fetch(SERPER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        console.warn(`[SearchProviders:serper] HTTP ${res.status}: ${text.slice(0, 300)}`)
        return []
      }
      const json = await res.json().catch(() => null)
      const results = mapSerperJson(json).slice(0, limit)
      return results
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("abort") || msg.includes("timeout")) {
        console.warn(`[SearchProviders:serper] fetch aborted/timeout for "${query.slice(0, 80)}": ${msg}`)
      } else {
        console.warn(`[SearchProviders:serper] fetch failed: ${msg}`)
      }
      return []
    } finally {
      clearTimeout(timeoutId)
    }
  },
}

export function __testMapSerperJson(json: unknown): SearchResult[] {
  return mapSerperJson(json)
}
