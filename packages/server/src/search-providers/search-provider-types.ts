export interface SearchResult {
  url: string
  title: string
  snippet: string
  /** ISO timestamp string when source published or fetched */
  timestamp?: string
  /** Provider name: brave | tavily | serper */
  source: string
}

export interface SearchProvider {
  readonly name: string
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
}

export interface SearchOptions {
  limit?: number
  signal?: AbortSignal
  timeoutMs?: number
}
