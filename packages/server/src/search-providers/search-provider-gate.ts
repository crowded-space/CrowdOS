import type { SearchResult, SearchOptions } from "./search-provider-types.js"
import { braveProvider } from "./providers/brave.js"
import { tavilyProvider } from "./providers/tavily.js"
import { serperProvider } from "./providers/serper.js"

// Unified normalize for URL dedupe — used by gate (URL only) and ResearchRuntime (URL+similarity)
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    // Lowercase host, strip www., remove trailing slash, strip tracking params & fragment
    let host = u.hostname.toLowerCase()
    if (host.startsWith("www.")) host = host.slice(4)
    // Remove default ports
    const port = u.port
    const isDefaultPort = (u.protocol === "http:" && port === "80") || (u.protocol === "https:" && port === "443")
    const hostPort = isDefaultPort || !port ? host : `${host}:${port}`
    let pathname = u.pathname
    // Remove trailing slash (except root)
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1)
    // Keep pathname lowercase? keep case-sensitive path but lower host; for dedupe, lower entire path as well
    pathname = pathname.toLowerCase()
    // Strip tracking query params
    const TRACKING_PREFIXES = ["utm_", "fbclid", "gclid", "igshid", "mc_eid"]
    const TRACKING_EXACT = new Set(["fbclid", "gclid", "igshid"])
    const params = new URLSearchParams(u.search)
    const kept: Array<[string, string]> = []
    for (const [k, v] of params.entries()) {
      const lk = k.toLowerCase()
      if (TRACKING_EXACT.has(lk)) continue
      if (TRACKING_PREFIXES.some((p) => lk.startsWith(p))) continue
      kept.push([k, v])
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    const search = kept.length > 0 ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : ""
    // Rebuild without fragment, lowercased
    return `${u.protocol}//${hostPort}${pathname}${search}`
  } catch {
    // Fallback: trim, lower, strip trailing slash and fragment
    let s = raw.trim().toLowerCase()
    const hashIdx = s.indexOf("#")
    if (hashIdx !== -1) s = s.slice(0, hashIdx)
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
    return s
  }
}

export function dedupeByUrl(results: SearchResult[]): { deduped: SearchResult[]; duplicates: Array<{ url: string; duplicateOf: string }> } {
  const seen = new Map<string, SearchResult>()
  const deduped: SearchResult[] = []
  const duplicates: Array<{ url: string; duplicateOf: string }> = []
  for (const r of results) {
    const key = normalizeUrl(r.url)
    if (seen.has(key)) {
      duplicates.push({ url: r.url, duplicateOf: seen.get(key)!.url })
    } else {
      seen.set(key, r)
      deduped.push(r)
    }
  }
  return { deduped, duplicates }
}

function tokenizeSnippet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length > 2)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const tok of a) if (b.has(tok)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function dedupeEvidence(
  results: SearchResult[],
  similarityThreshold = 0.8
): { deduped: SearchResult[]; duplicates: Array<{ url: string; reason: string; duplicateOf?: string; snippetSimilarity?: number }> } {
  const deduped: SearchResult[] = []
  const duplicates: Array<{ url: string; reason: string; duplicateOf?: string; snippetSimilarity?: number }> = []
  const seenUrls = new Map<string, SearchResult>()
  const seenSnippets: Array<{ result: SearchResult; tokens: Set<string> }> = []
  for (const r of results) {
    const nUrl = normalizeUrl(r.url)
    if (seenUrls.has(nUrl)) {
      duplicates.push({ url: r.url, reason: "duplicate_url", duplicateOf: seenUrls.get(nUrl)!.url })
      continue
    }
    const tok = tokenizeSnippet(r.snippet)
    let isNearDup = false
    for (const { result: kept, tokens: keptTok } of seenSnippets) {
      const sim = jaccard(tok, keptTok)
      if (sim >= similarityThreshold) {
        duplicates.push({ url: r.url, reason: "near_duplicate_snippet", duplicateOf: kept.url, snippetSimilarity: Math.round(sim * 100) / 100 })
        isNearDup = true
        break
      }
    }
    if (isNearDup) continue
    seenUrls.set(nUrl, r)
    seenSnippets.push({ result: r, tokens: tok })
    deduped.push(r)
  }
  return { deduped, duplicates }
}

export function sortByFreshness(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  })
}

type ProviderEntry = { name: string; provider: typeof braveProvider }

function configuredProviders(): ProviderEntry[] {
  const out: ProviderEntry[] = []
  // Priority order: brave > tavily > serper (most configurable order; can be overridden via SEARCH_PROVIDER_PRIORITY env if present)
  const priorityRaw = process.env.SEARCH_PROVIDER_PRIORITY?.trim().toLowerCase()
  const customPriority = priorityRaw ? priorityRaw.split(",").map((s) => s.trim()).filter(Boolean) : null
  const order = customPriority && customPriority.length > 0 ? customPriority : ["brave", "tavily", "serper"]
  const map: Record<string, ProviderEntry> = {
    brave: { name: "brave", provider: braveProvider },
    tavily: { name: "tavily", provider: tavilyProvider },
    serper: { name: "serper", provider: serperProvider },
  }
  for (const key of order) {
    const entry = map[key]
    if (entry) out.push(entry)
  }
  // Ensure any missing keys from default still appended if custom omitted them
  if (customPriority) {
    for (const k of ["brave", "tavily", "serper"]) {
      if (!order.includes(k)) out.push(map[k])
    }
  }
  return out
}

export async function searchProviders(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const providers = configuredProviders()
  const allResults: SearchResult[] = []
  const attempted: string[] = []
  for (const { name, provider } of providers) {
    try {
      attempted.push(name)
      const results = await provider.search(q, opts)
      if (results.length > 0) {
        allResults.push(...results)
      }
    } catch (err) {
      console.warn(`[SearchProviders] ${name} search failed for "${q.slice(0, 80)}":`, err instanceof Error ? err.message : String(err))
    }
  }
  if (allResults.length === 0 && attempted.length > 0) {
    // Check if any key was configured — if none, log graceful fallback once
    const anyKey =
      !!process.env.BRAVE_API_KEY?.trim() ||
      !!process.env.TAVILY_API_KEY?.trim() ||
      !!process.env.SERPER_API_KEY?.trim()
    if (!anyKey) {
      console.warn("[SearchProviders] No search provider configured — returning []")
    }
  }
  // Deduplicate by normalized URL
  const { deduped } = dedupeByUrl(allResults)
  // Respect opts.limit if provided (gate limit caps final returned)
  const limit = opts?.limit
  if (typeof limit === "number" && limit > 0 && deduped.length > limit) {
    return deduped.slice(0, limit)
  }
  return deduped
}

// Facade object for domain gate standard
export const searchProviderGate = {
  search: searchProviders,
  normalizeUrl,
  dedupeByUrl,
  dedupeEvidence,
  sortByFreshness,
}

// Re-export types for consumers
export type { SearchResult, SearchProvider, SearchOptions } from "./search-provider-types.js"
