import { searchProviders, normalizeUrl, dedupeByUrl, dedupeEvidence, sortByFreshness } from "./search-provider-service.js"

export const searchProviderGate = {
  search: searchProviders,
  normalizeUrl,
  dedupeByUrl,
  dedupeEvidence,
  sortByFreshness,
}

export { searchProviders, normalizeUrl, dedupeByUrl, dedupeEvidence, sortByFreshness }

export type { SearchResult, SearchProvider, SearchOptions } from "./search-provider-types.js"
