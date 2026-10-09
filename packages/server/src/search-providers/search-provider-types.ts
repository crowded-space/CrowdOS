export type searchSource = "brave" | "tavily" | "serper"

export interface SearchResult {
  url: string
  title: string
  snippet: string
  /** ISO timestamp string when source published or fetched */
  timestamp?: string
  /** SP-02: validated provider union — a mapper typo fails compile, not artifacts. */
  source: searchSource
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
