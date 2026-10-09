import type { SearchResult, SearchProvider, SearchOptions, searchSource } from "../search-provider-types.js"

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_LIMIT = 10

let warnedNoKey = false

function getBraveKey(): string | undefined {
  // Prefer Shared/config/env mirror via process.env (zod loads it at boot)
  const raw = process.env.BRAVE_API_KEY?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

function mapBraveJson(json: unknown, source: searchSource): SearchResult[] {
  const out: SearchResult[] = []
  if (!json || typeof json !== "object") return out
  const obj = json as Record<string, unknown>
  // Brave shape: { web: { results: [...] } } or { results: [...] }
  const web = (obj.web as Record<string, unknown> | undefined) ?? obj
  const results = (web.results as unknown[] | undefined) ?? (obj.results as unknown[] | undefined)
  if (!Array.isArray(results)) return out
  let unparsableTimestamps = 0
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
      else unparsableTimestamps++
    }
    // If no timestamp, leave undefined — freshness sorter keeps those at the end
    out.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 2000), timestamp, source })
  }
  if (unparsableTimestamps > 0) {
    console.warn(`[SearchProviders:brave] ${unparsableTimestamps} result timestamp(s) unparseable (e.g. relative dates) — dropped, rows keep no freshness signal`)
  }
  return out
}

export const braveProvider: SearchProvider = {
  name: "brave",
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getBraveKey()
    if (!apiKey) {
      if (!warnedNoKey) {
        warnedNoKey = true
        console.warn("[SearchProviders:brave] Brave search unavailable — returning [] (graceful fallback)")
      }
      return []
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 20)
    const rawTimeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // SP-07: non-finite timeouts clamp setTimeout to ~1ms (instant abort). Fall back to default.
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Brave search timeout")), timeoutMs)
    // Compose with caller signal
    const callerSignal = opts?.signal
    const onCallerAbort = (): void => controller.abort(callerSignal!.reason)
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    }
    let res: Response
    try {
      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("abort") || msg.includes("timeout")) {
        console.warn(`[SearchProviders:brave] fetch aborted/timeout for "${query.slice(0, 80)}": ${msg}`)
      } else {
        console.warn(`[SearchProviders:brave] fetch failed: ${msg}`)
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
        console.warn(`[SearchProviders:brave] HTTP 429 rate-limited${retryAfter ? `, Retry-After: ${retryAfter}` : ""}: ${text.slice(0, 300)}`)
        throw new Error(`HTTP 429 rate-limited${retryAfter ? `, Retry-After: ${retryAfter}` : ""}`)
      }
      console.warn(`[SearchProviders:brave] HTTP ${res.status}: ${text.slice(0, 300)}`)
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json().catch(() => null)
    if (json === null) {
      console.warn(`[SearchProviders:brave] HTTP 200 but unparseable JSON response`)
      throw new Error("HTTP 200 but unparseable JSON")
    }
    return mapBraveJson(json, "brave").slice(0, limit)
  },
}

export function __testMapBraveJson(json: unknown): SearchResult[] {
  return mapBraveJson(json, "brave")
}
