// Read-only audit probe: confirms edge cases in search-provider-service helpers.
// Run: node_modules\.bin\tsx.cmd audit/domains/search-providers/probe/dedupe-probe.ts
import { dedupeEvidence, dedupeByUrl, normalizeUrl, sortByFreshness } from "../../../../packages/server/src/search-providers/search-provider-service.js"
import type { SearchResult } from "../../../../packages/server/src/search-providers/search-provider-types.js"

const row = (url: string, snippet: string, title = "T"): SearchResult => ({ url, title, snippet, source: "brave" })

// Case 1: two distinct URLs, both empty snippets
const c1 = dedupeEvidence([row("https://a.com/1", ""), row("https://b.com/2", "")])
console.log("C1 distinct-urls-empty-snippets: kept=" + c1.deduped.length + " dropped=" + JSON.stringify(c1.duplicates.map(d => ({ url: d.url, reason: d.reason }))))

// Case 2: empty + non-empty snippet
const c2 = dedupeEvidence([row("https://a.com/1", ""), row("https://b.com/2", "real content here")])
console.log("C2 empty+real: kept=" + c2.deduped.length)

// Case 3: both empty snippets via dedupeByUrl (url-only) — control
const c3 = dedupeByUrl([row("https://a.com/1", ""), row("https://b.com/2", "")])
console.log("C3 dedupeByUrl distinct: kept=" + c3.deduped.length)

// Case 4: short tokens (<=2 chars) tokenize to empty set
const c4 = dedupeEvidence([row("https://a.com/1", "ok go"), row("https://b.com/2", "hi me")])
console.log("C4 short-token-snippets: kept=" + c4.deduped.length)

// Case 5: normalizeUrl non-URL fallback + port handling
console.log("C5 normalize('not a url')=" + JSON.stringify(normalizeUrl("not a url")))
console.log("C5 normalize('HTTPS://EXAMPLE.com:8443/x/')" + "=" + JSON.stringify(normalizeUrl("HTTPS://EXAMPLE.com:8443/x/")))
console.log("C5 normalize('https://example.com:80/x')=" + JSON.stringify(normalizeUrl("https://example.com:80/x")))
console.log("C5 normalize('https://example.com:443/x')=" + JSON.stringify(normalizeUrl("https://example.com:443/x")))

// Case 6: sortByFreshness unparsable ordering
const s = sortByFreshness([
  { ...row("https://a.com/1", "x"), timestamp: undefined },
  { ...row("https://b.com/2", "x"), timestamp: "2024-01-01T00:00:00Z" },
  { ...row("https://c.com/3", "x"), timestamp: "garbage" },
])
console.log("C6 sort order: " + s.map(r => r.url.split("/").pop()).join(","))

// Case 7: snippet-only threshold boundary (identical snippets, distinct urls)
const c7 = dedupeEvidence([row("https://a.com/1", "alpha beta gamma delta"), row("https://b.com/2", "alpha beta gamma delta")])
console.log("C7 identical-snippets-distinct-urls: kept=" + c7.deduped.length + " reason=" + (c7.duplicates[0]?.reason ?? "-") + " sim=" + (c7.duplicates[0]?.snippetSimilarity ?? "-"))
