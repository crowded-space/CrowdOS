import type { SearchResult, SearchProvider, SearchOptions } from "../search-provider-types.js"

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_LIMIT = 10

function getBraveKey(): string | undefined {
  // Prefer Shared/config/env mirror via process.env (zod loads it at boot)
  const raw = process.env.BRAVE_API_KEY?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

function mapBraveJson(json: unknown, source: string): SearchResult[] {
  const out: SearchResult[] = []
  if (!json || typeof json !== "object") return out
  const obj = json as Record<string, unknown>
  // Brave shape: { web: { results: [...] } } or { results: [...] }
  const web = (obj.web as Record<string, unknown> | undefined) ?? obj
  const results = (web.results as unknown[] | undefined) ?? (obj.results as unknown[] | undefined)
  if (!Array.isArray(results)) return out
  for (const r of results) {
    if (!r || typeof r !== "object") continue
    const rec = r as Record<string, unknown>
    const url = typeof rec.url === "string" ? rec.url : typeof rec.link === "string" ? rec.link : null
    if (!url) continue
    const title = typeof rec.title === "string" ? rec.title : url
    const snippet =
      typeof rec.description === "string" ? rec.description
      : typeof rec.snippet === "string" ? rec.snippet
      : typeof rec.content === "string" ? rec.content
      : ""
    // Brave age fields: age, page_age, article_age
    let timestamp: string | undefined
    const ageRaw = (rec.age as string | undefined) ?? (rec.page_age as string | undefined) ?? (rec.published_date as string | undefined) ?? (rec.date as string | undefined)
    if (typeof ageRaw === "string" && ageRaw) {
      const parsed = Date.parse(ageRaw)
      if (!Number.isNaN(parsed)) timestamp = new Date(parsed).toISOString()
      else timestamp = ageRaw
    }
    // If no timestamp, leave undefined — freshness sorter treats as oldest
    out.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 2000), timestamp, source })
  }
  return out
}

export const braveProvider: SearchProvider = {
  name: "brave",
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getBraveKey()
    if (!apiKey) {
      console.warn("[SearchProviders:brave] Brave search unavailable — returning [] (graceful fallback)")
      return []
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 20)
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Brave search timeout")), timeoutMs)
    // Compose with caller signal
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason)
      else opts.signal.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true })
    }
    try {
      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        console.warn(`[SearchProviders:brave] HTTP ${res.status}: ${text.slice(0, 300)}`)
        return []
      }
      const json = await res.json().catch(() => null)
      const results = mapBraveJson(json, "brave").slice(0, limit)
      return results
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("abort") || msg.includes("timeout")) {
        console.warn(`[SearchProviders:brave] fetch aborted/timeout for "${query.slice(0, 80)}": ${msg}`)
      } else {
        console.warn(`[SearchProviders:brave] fetch failed: ${msg}`)
      }
      return []
    } finally {
      clearTimeout(timeoutId)
    }
  },
}

export function __testMapBraveJson(json: unknown): SearchResult[] {
  return mapBraveJson(json, "brave")
}
