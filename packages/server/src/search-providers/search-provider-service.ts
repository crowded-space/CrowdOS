import type { SearchResult, SearchOptions, SearchProvider } from "./search-provider-types.js"
import { braveProvider } from "./providers/brave.js"
import { tavilyProvider } from "./providers/tavily.js"
import { serperProvider } from "./providers/serper.js"

const MAX_QUERY_LENGTH = 512

let warnedNoKey = false
const warnedUnknownPriority = new Set<string>()

// Unified normalize for URL dedupe — used by gate (URL only) and ResearchRuntime (URL+similarity)
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    let host = u.hostname.toLowerCase()
    if (host.startsWith("www.")) host = host.slice(4)
    const port = u.port
    const isHttp = u.protocol === "http:" || u.protocol === "https:"
    const isDefaultPort = isHttp ? port === "80" || port === "443" : false
    const hostPort = isDefaultPort || !port ? host : `${host}:${port}`
    let pathname = u.pathname
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, pathname.length - 1)
    // Keep pathname case-sensitive (lowercasing corrupts case-sensitive URLs); host already lowered.
    const TRACKING_PREFIXES = ["utm_", "fbclid", "gclid", "igshid", "mc_eid"]
    const params = new URLSearchParams(u.search)
    const kept: Array<[string, string]> = []
    for (const [k, v] of params.entries()) {
      const lk = k.toLowerCase()
      if (TRACKING_PREFIXES.some((p) => lk.startsWith(p))) continue
      kept.push([k, v])
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    const search = kept.length > 0 ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : ""
    // http and https are the same page for dedupe — canonicalize to https (result keeps its original URL)
    const protocol = u.protocol === "http:" ? "https:" : u.protocol
    return `${protocol}//${hostPort}${pathname}${search}`
  } catch {
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
    try {
      if (!r || typeof r.url !== "string") throw new Error("malformed result: missing url")
      const key = normalizeUrl(r.url)
      if (seen.has(key)) {
        // SP-08: merge a missing timestamp from the duplicate onto the kept
        // row so freshness sort does not bury it as unparsable.
        const kept = seen.get(key)!;
        if (!(kept as unknown as Record<string, unknown>).timestamp && (r as unknown as Record<string, unknown>).timestamp) {
          (kept as unknown as Record<string, unknown>).timestamp = (r as unknown as Record<string, unknown>).timestamp;
        }
        duplicates.push({ url: r.url, duplicateOf: seen.get(key)!.url })
      } else {
        seen.set(key, r)
        deduped.push(r)
      }
    } catch (err) {
      console.warn("[SearchProviders] skipping malformed result:", err instanceof Error ? err.message : String(err))
      continue
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
  // SP-01: two empty token sets carry no similarity signal. Returning 1
  // dropped distinct URLs with empty/short snippets as near-duplicates.
  if (a.size === 0 && b.size === 0) return 0
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
    try {
      if (!r || typeof r.url !== "string") throw new Error("malformed result: missing url")
      const nUrl = normalizeUrl(r.url)
      if (seenUrls.has(nUrl)) {
        duplicates.push({ url: r.url, reason: "duplicate_url", duplicateOf: seenUrls.get(nUrl)!.url })
        continue
      }
      const tok = tokenizeSnippet(typeof r.snippet === "string" ? r.snippet : "")
      let isNearDup = false
      // ponytail: O(n²) Jaccard capped — past 200 kept snippets skip near-dup check, URL-dedupe only.
      if (seenSnippets.length <= 200) {
        for (const { result: kept, tokens: keptTok } of seenSnippets) {
          const sim = jaccard(tok, keptTok)
          if (sim >= similarityThreshold) {
            duplicates.push({ url: r.url, reason: "near_duplicate_snippet", duplicateOf: kept.url, snippetSimilarity: Math.round(sim * 100) / 100 })
            isNearDup = true
            break
          }
        }
      }
      if (isNearDup) continue
      seenUrls.set(nUrl, r)
      seenSnippets.push({ result: r, tokens: tok })
      deduped.push(r)
    } catch (err) {
      console.warn("[SearchProviders] skipping malformed result:", err instanceof Error ? err.message : String(err))
      continue
    }
  }
  return { deduped, duplicates }
}

export function sortByFreshness(results: SearchResult[]): SearchResult[] {
  // Rows without a parsable timestamp carry no freshness signal: they stay in input
  // order at the end instead of sorting as epoch-0 garbage.
  const valid: Array<{ result: SearchResult; t: number }> = []
  const unparsable: SearchResult[] = []
  for (const r of results) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (Number.isNaN(t)) unparsable.push(r)
    else valid.push({ result: r, t })
  }
  valid.sort((a, b) => b.t - a.t)
  return [...valid.map((v) => v.result), ...unparsable]
}

// SP-06: type the entry as the SearchProvider port so provider shapes cannot drift.
type ProviderEntry = { name: string; provider: SearchProvider }

function configuredProviders(): ProviderEntry[] {
  const out: ProviderEntry[] = []
  const priorityRaw = process.env.SEARCH_PROVIDER_PRIORITY?.trim().toLowerCase()
  const customPriority = priorityRaw ? priorityRaw.split(",").map((s) => s.trim()).filter(Boolean) : null
  const order = customPriority && customPriority.length > 0 ? customPriority : ["brave", "tavily", "serper"]
  const map: Record<string, ProviderEntry> = {
    brave: { name: "brave", provider: braveProvider },
    tavily: { name: "tavily", provider: tavilyProvider },
    serper: { name: "serper", provider: serperProvider },
  }
  const seen = new Set<string>()
  for (const key of order) {
    if (seen.has(key)) continue
    seen.add(key)
    const entry = map[key]
    if (entry) out.push(entry)
    else if (!warnedUnknownPriority.has(key)) {
      warnedUnknownPriority.add(key)
      console.warn(`[SearchProviders] SEARCH_PROVIDER_PRIORITY unknown provider "${key}" — valid: brave, tavily, serper`)
    }
  }
  if (customPriority) {
    for (const k of ["brave", "tavily", "serper"]) {
      if (seen.has(k)) continue
      seen.add(k)
      out.push(map[k])
    }
  }
  return out
}

export async function searchProviders(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
  if (typeof query !== "string") return []
  let q = query.trim()
  if (!q) return []
  if (q.length > MAX_QUERY_LENGTH) q = q.slice(0, MAX_QUERY_LENGTH)
  const rawLimit = opts?.limit
  let limit: number | undefined
  if (typeof rawLimit === "number") {
    if (Number.isFinite(rawLimit)) {
      if (rawLimit <= 0) return []
      limit = Math.floor(rawLimit)
    }
    // non-finite (NaN/±Infinity) → default behavior: no final cap
  }
  const providers = configuredProviders()
  const allResults: SearchResult[] = []
  const attempted: string[] = []
  let failed = 0
  // First provider gets the FULL limit (it dedupes anyway) so the early-exit is
  // reachable; the rest split ceil(limit/n) each.
  const perProviderLimit = (index: number): number | undefined =>
    limit === undefined ? undefined : index === 0 ? limit : Math.ceil(limit / providers.length)

  const [first, ...rest] = providers
  try {
    attempted.push(first.name)
    allResults.push(...(await first.provider.search(q, { ...opts, limit: perProviderLimit(0) })))
    if (limit !== undefined) {
      const { deduped } = dedupeByUrl(allResults)
      if (deduped.length >= limit) return deduped.slice(0, limit)
    }
  } catch (err) {
    failed++
    console.warn(`[SearchProviders] ${first.name} search failed for "${q.slice(0, 80)}":`, err instanceof Error ? err.message : String(err))
  }

  if (rest.length > 0) {
    for (const { name } of rest) attempted.push(name)
    const settled = await Promise.allSettled(rest.map(({ provider }, i) => provider.search(q, { ...opts, limit: perProviderLimit(i + 1) })))
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        allResults.push(...r.value)
      } else {
        failed++
        console.warn(`[SearchProviders] ${rest[i].name} search failed for "${q.slice(0, 80)}":`, r.reason instanceof Error ? r.reason.message : String(r.reason))
      }
    })
  }
  if (attempted.length > 0 && failed === attempted.length) {
    console.warn(`[SearchProviders] ALL ${failed} attempted providers failed for "${q.slice(0, 80)}" — returning []`)
  }
  if (allResults.length === 0 && attempted.length > 0) {
    const anyKey =
      !!process.env.BRAVE_API_KEY?.trim() ||
      !!process.env.TAVILY_API_KEY?.trim() ||
      !!process.env.SERPER_API_KEY?.trim()
    if (!anyKey && !warnedNoKey) {
      warnedNoKey = true
      console.warn("[SearchProviders] No search provider configured — returning []")
    }
  }
  const { deduped } = dedupeByUrl(allResults)
  if (limit !== undefined) {
    return deduped.slice(0, limit)
  }
  return deduped
}
