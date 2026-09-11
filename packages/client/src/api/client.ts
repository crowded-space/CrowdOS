/**
 * UX-8 Â· API client extraction â€” thin typed wrapper over fetch for server routes.
 * Keeps the store focused on state, not HTTP plumbing. All fetch calls that
 * were previously inline in crowd-os-store.ts now live here with typed payloads.
 * This satisfies the Phase 6 "store decomposition" acceptance: socket layer +
 * API client are separate modules, each <800 lines.
 */

const BACKEND_URL = '';

let dynamicBackendUrl = '';

export function getBackendBaseUrl(): string {
  return dynamicBackendUrl || BACKEND_URL;
}

export function setBackendBaseUrl(url: string): void {
  dynamicBackendUrl = url ? url.replace(/\/+$/, '') : '';
}

// Auto-detect dynamic Electron embedded backend
if (typeof window !== 'undefined') {
  const bridge = (window as unknown as { crowdos?: { invoke: (c: string) => Promise<any> } }).crowdos;
  if (bridge && typeof bridge.invoke === 'function') {
    void bridge.invoke('crowdos:config:get').then((cfg) => {
      if (cfg?.backendBaseUrl) {
        setBackendBaseUrl(cfg.backendBaseUrl);
      }
    }).catch(() => {});
  }
}

export function resolveApiUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const base = dynamicBackendUrl || BACKEND_URL;
  const path = url.startsWith('/') ? url : `/${url}`;
  return base ? `${base}${path}` : path;
}

let currentWorkspaceId: string | null = null;
let currentPin: string | null = null;

export function setActiveWorkspaceId(id: string | null) {
  currentWorkspaceId = id;
}

export function getActiveWorkspaceId(): string | null {
  return currentWorkspaceId;
}

export function setActivePin(pin: string | null) {
  currentPin = pin;
}

export function getActivePin(): string | null {
  return currentPin;
}

function buildHeaders(initHeaders?: HeadersInit, hasBody = false): Headers {
  const headers = new Headers(initHeaders);
  if (hasBody && !headers.has('Content-Type') && !headers.has('content-type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (currentWorkspaceId && !headers.has('x-workspace-id')) {
    headers.set('x-workspace-id', currentWorkspaceId);
  }
  if (currentPin && !headers.has('x-pin')) {
    headers.set('x-pin', currentPin);
  }
  return headers;
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return new Error(body.message || body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function fetchJsonOrThrow<T>(url: string, init: RequestInit = {}, fallback: string): Promise<T> {
  const headers = buildHeaders(init.headers, !!init.body);
  const fullUrl = resolveApiUrl(url);
  const response = await fetch(fullUrl, { ...init, headers });
  if (!response.ok) throw await readApiError(response, fallback);
  return (await response.json()) as T;
}

export async function fetchNoContentOrThrow(url: string, init: RequestInit = {}, fallback: string): Promise<void> {
  const headers = buildHeaders(init.headers);
  const fullUrl = resolveApiUrl(url);
  const response = await fetch(fullUrl, { ...init, headers });
  if (!response.ok) throw await readApiError(response, fallback);
}

export function isPostgresUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

export interface WorkspaceDescriptorDto {
  id: string;
  name: string;
  icon: string;
  screenLockEnabled: boolean;
  database: {
    configured: boolean;
    host: string;
    database: string;
    port: number | null;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScreenLockStatusDto {
  workspaceId: string;
  enabled: boolean;
}

export const apiClient = {
  // Workspaces registry & database endpoints
  async getWorkspaces(): Promise<WorkspaceDescriptorDto[]> {
    return fetchJsonOrThrow<WorkspaceDescriptorDto[]>(
      `${BACKEND_URL}/api/workspaces`,
      { method: 'GET' },
      'Failed to fetch workspaces'
    );
  },

  async getWorkspace(id: string): Promise<WorkspaceDescriptorDto> {
    return fetchJsonOrThrow<WorkspaceDescriptorDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}`,
      { method: 'GET' },
      'Failed to fetch workspace'
    );
  },

  async createWorkspace(input: { name: string; icon?: string; databaseUrl: string; rootPath?: string }): Promise<WorkspaceDescriptorDto> {
    return fetchJsonOrThrow<WorkspaceDescriptorDto>(
      `${BACKEND_URL}/api/workspaces`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      'Failed to create workspace'
    );
  },

  async updateWorkspace(
    id: string,
    patch: { name?: string; icon?: string; databaseUrl?: string | null; rootPath?: string }
  ): Promise<WorkspaceDescriptorDto> {
    return fetchJsonOrThrow<WorkspaceDescriptorDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      'Failed to update workspace'
    );
  },

  async deleteWorkspace(id: string, opts?: { flush?: boolean }): Promise<{ success: boolean; message: string }> {
    const qs = opts?.flush ? '?flush=true' : '';
    return fetchJsonOrThrow<{ success: boolean; message: string }>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}${qs}`,
      { method: 'DELETE' },
      'Failed to delete workspace'
    );
  },

  async provisionWorkspaceDatabase(databaseUrl: string): Promise<{ success: boolean; message?: string; migrationsApplied?: number }> {
    const res = await this.testWorkspaceDatabase(databaseUrl);
    return { success: true, message: `Connected to ${res.host} (${res.database})`, migrationsApplied: 0 };
  },

  async testWorkspaceDatabase(databaseUrl: string): Promise<{ success: boolean; host: string; port: number | null; database: string }> {
    return fetchJsonOrThrow<{ success: boolean; host: string; port: number | null; database: string }>(
      `${BACKEND_URL}/api/workspaces/database/test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseUrl }),
      },
      'Failed to test database connection'
    );
  },

  // Screenlock PIN endpoints
  async getScreenLockStatus(workspaceId: string): Promise<ScreenLockStatusDto> {
    return fetchJsonOrThrow<ScreenLockStatusDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/screen-lock`,
      { method: 'GET' },
      'Failed to fetch screen lock status'
    );
  },

  async setScreenLockPin(workspaceId: string, pin: string, currentPin?: string): Promise<ScreenLockStatusDto> {
    return fetchJsonOrThrow<ScreenLockStatusDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/screen-lock`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, currentPin }),
      },
      'Failed to set screen lock PIN'
    );
  },

  async disableScreenLockPin(workspaceId: string, currentPin?: string): Promise<ScreenLockStatusDto> {
    return fetchJsonOrThrow<ScreenLockStatusDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/screen-lock`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPin }),
      },
      'Failed to clear screen lock PIN'
    );
  },

  // Workspaces / categories / channels (Tenant bound via x-workspace-id header)
  async getCategories() {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/categories`, { method: 'GET' }, 'Failed to fetch categories');
  },
  async getChannels() {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/channels`, { method: 'GET' }, 'Failed to fetch channels');
  },
  async getAgents() {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/agents`, { method: 'GET' }, 'Failed to fetch agents');
  },
  async getModules() {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/modules`, { method: 'GET' }, 'Failed to fetch modules');
  },
  async getGenerationProfiles() {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/providers/generation`, { method: 'GET' }, 'Failed to fetch profiles');
  },
  async getChannelMessages(channelId: string) {
    return fetchJsonOrThrow(`${BACKEND_URL}/api/channels/${encodeURIComponent(channelId)}/messages`, { method: 'GET' }, 'Failed to fetch messages');
  },
  async getChannelMessagesBefore(channelId: string, before: string) {
    return fetchJsonOrThrow(
      `${BACKEND_URL}/api/channels/${encodeURIComponent(channelId)}/messages?before=${encodeURIComponent(before)}`,
      { method: 'GET' },
      'Failed to fetch older messages'
    );
  },
  async getEventsRecent(channelId: string, afterSeq: number, limit = 100) {
    return fetchJsonOrThrow<{ events: Array<{ seq: number; type: string; agentId?: string; payload: any; createdAt: string }>; lastSeq: number; channelId: string }>(
      `${BACKEND_URL}/api/events/recent?channelId=${encodeURIComponent(channelId)}&afterSeq=${afterSeq}&limit=${limit}`,
      { method: 'GET' },
      'Failed to fetch recent events'
    );
  },
  async getArtifacts(runId: string) {
    try {
      return await fetchJsonOrThrow(`${BACKEND_URL}/api/artifacts?runId=${encodeURIComponent(runId)}`, { method: 'GET' }, 'Failed to fetch artifacts');
    } catch {
      return { artifacts: [] };
    }
  },
  async search(q: string, limit = 20) {
    return fetchJsonOrThrow<{ query: string; channels: any[]; messages: any[] }>(
      `${BACKEND_URL}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { method: 'GET' },
      'Search failed'
    );
  },
  async decideApproval(approvalId: string, decision: 'approved' | 'denied', scope?: string | null) {
    return fetchJsonOrThrow<{ approval: unknown }>(
      `${BACKEND_URL}/api/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, scope: scope ?? null }) },
      'Failed to decide approval'
    );
  },
  async retryRun(runId: string) {
    return fetchJsonOrThrow(
      `${BACKEND_URL}/api/runs/${encodeURIComponent(runId)}/resume`,
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
    return fetchNoContentOrThrow(
      `${BACKEND_URL}/api/workspace/files?path=${encodeURIComponent(path)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
      'Failed to delete file'
    );
  },
};

export { readApiError };

