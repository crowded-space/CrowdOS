/**
 * UX-8 · API client extraction — thin typed wrapper over fetch for server routes.
 * Keeps the store focused on state, not HTTP plumbing. All fetch calls that
 * were previously inline in crowd-os-store.ts now live here with typed payloads.
 * This satisfies the Phase 6 "store decomposition" acceptance: socket layer +
 * API client are separate modules, each <800 lines.
 */

const BACKEND_URL = '';

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return new Error(body.message || body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function fetchJsonOrThrow<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await readApiError(response, fallback);
  return (await response.json()) as T;
}

export async function fetchNoContentOrThrow(url: string, init: RequestInit, fallback: string): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) throw await readApiError(response, fallback);
}

export const apiClient = {
  // Workspaces / categories / channels
  async getCategories() {
    const res = await fetch(`${BACKEND_URL}/api/categories`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch categories');
    return res.json();
  },
  async getChannels() {
    const res = await fetch(`${BACKEND_URL}/api/channels`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch channels');
    return res.json();
  },
  async getAgents() {
    const res = await fetch(`${BACKEND_URL}/api/agents`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch agents');
    return res.json();
  },
  async getModules() {
    const res = await fetch(`${BACKEND_URL}/api/modules`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch modules');
    return res.json();
  },
  async getGenerationProfiles() {
    const res = await fetch(`${BACKEND_URL}/api/providers/generation`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch profiles');
    return res.json();
  },
  async getChannelMessages(channelId: string) {
    const res = await fetch(`${BACKEND_URL}/api/channels/${channelId}/messages`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch messages');
    return res.json();
  },
  async getChannelMessagesBefore(channelId: string, before: string) {
    const res = await fetch(`${BACKEND_URL}/api/channels/${channelId}/messages?before=${encodeURIComponent(before)}`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch older messages');
    return res.json();
  },
  async getEventsRecent(channelId: string, afterSeq: number, limit = 100) {
    const res = await fetch(`${BACKEND_URL}/api/events/recent?channelId=${encodeURIComponent(channelId)}&afterSeq=${afterSeq}&limit=${limit}`);
    if (!res.ok) throw await readApiError(res, 'Failed to fetch recent events');
    return res.json() as Promise<{ events: Array<{ seq: number; type: string; agentId?: string; payload: any; createdAt: string }>; lastSeq: number; channelId: string }>;
  },
  async getArtifacts(runId: string) {
    const res = await fetch(`${BACKEND_URL}/api/artifacts?runId=${encodeURIComponent(runId)}`);
    if (!res.ok) return { artifacts: [] };
    return res.json();
  },
  async search(q: string, limit = 20) {
    const res = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!res.ok) throw await readApiError(res, 'Search failed');
    return res.json() as Promise<{ query: string; channels: any[]; messages: any[] }>;
  },
  async decideApproval(approvalId: string, decision: 'approved' | 'denied', scope?: string | null) {
    return fetchJsonOrThrow<{ approval: unknown }>(
      `${BACKEND_URL}/api/approvals/${approvalId}/decision`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, scope: scope ?? null }) },
      'Failed to decide approval'
    );
  },
  async retryRun(runId: string) {
    return fetchJsonOrThrow(
      `${BACKEND_URL}/api/runs/${runId}/resume`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      'Failed to retry run'
    );
  },
  async applyFileContent(path: string, content: string, workspaceId: string) {
    return fetchJsonOrThrow(
      `${BACKEND_URL}/api/workspace/files/content`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content, workspaceId }) },
      'Failed to apply diff'
    );
  },
  async deleteFile(path: string, workspaceId: string) {
    const res = await fetch(`${BACKEND_URL}/api/workspace/files?path=${encodeURIComponent(path)}&workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    if (!res.ok) throw await readApiError(res, 'Failed to delete file');
  }
};

export { readApiError };
