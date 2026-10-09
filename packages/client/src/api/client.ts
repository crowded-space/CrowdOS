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
// SEC-1 (§19): the mounted REST gate is default-deny for NON-loopback callers.
// The embedded desktop backend is reached over loopback and needs no key, so this
// stays opt-in and defaults to null — setting a key must never be required to run
// the local app. It exists so a browser client on another host can authenticate.
let currentApiKey: string | null = null;

export function setActiveApiKey(key: string | null) {
  currentApiKey = key && key.trim() ? key.trim() : null;
}

export function getActiveApiKey(): string | null {
  return currentApiKey;
}

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
  // Only sent when a key is actually configured; the loopback desktop flow
  // never sets one and keeps working without a credential.
  if (currentApiKey && !headers.has('x-api-key')) {
    headers.set('x-api-key', currentApiKey);
  }
  return headers;
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    const error = new Error(body.message || body.error || fallback) as Error & { status: number };
    // Carry the status so callers can tell not-found from not-allowed without
    // string-matching the message; the repository panel branches on it.
    error.status = response.status;
    return error;
  } catch {
    const error = new Error(fallback) as Error & { status: number };
    error.status = response.status;
    return error;
  }
}

/** HTTP status of a failed fetchJsonOrThrow / fetchNoContentOrThrow call. */
export function apiErrorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : null;
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
  storagePreference?: 'default' | 'local';
  dbSync?: { dbWorkspaceId: string | null; state: 'paired' | 'conflict' | 'importing' | 'pushing'; updatedAt: string } | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DbSyncStatusDto {
  workspaceId: string;
  storagePreference: 'default' | 'local';
  tier: 'dual' | 'local';
  dbConfigured: boolean;
  dbReachable: boolean;
  dbSync: { dbWorkspaceId: string | null; state: string; updatedAt: string } | null;
  backlog: number;
  backlogNotice: boolean;
  suggestion?: string;
}

export interface ScreenLockStatusDto {
  workspaceId: string;
  enabled: boolean;
}

// ─── Filesystem / Repo panel ──────────────────────────────────────────
// The panel and the agent file tools must resolve the same directory, so these
// call the same routes the tools' resolver feeds. `root` picks which of the two
// zones to list: `effective` is the mounted repo when there is one, otherwise the
// workspace sandbox; `workspace-local` is always the workspace sandbox (Zone A).

export type FileNodeDto = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mimeType?: string;
};

export type MountRootDto = 'effective' | 'workspace-local';

/** `MountScope` as the route serializes it, plus the root that was listed. */
export interface MountScopeDto {
  path: string;
  zone: 'mounted' | 'workspace-local';
  source: 'channel' | 'category' | 'workspace' | 'workspace-local';
  reason: string | null;
  workspaceRoot: string;
  displayName: string;
  root: MountRootDto;
  nodes: FileNodeDto[];
}

export type MountInfoDto = {
  workspaceId: string | null;
  mountedPath: string | null;
  source: 'channel' | 'category' | 'workspace' | 'none';
  reason?: string | null;
};

export type FsBrowseDto = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; path: string }>;
  allowedRoots: string[];
};

export type ModelTestResultDto = {
  success: boolean;
  message?: string;
  offline?: boolean;
};

function mountQuery(workspaceId: string, channelId: string | null | undefined, root: MountRootDto): string {
  const params = new URLSearchParams({ workspaceId, root });
  if (channelId) params.set('channelId', channelId);
  return params.toString();
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

  async createWorkspace(input: { name: string; icon?: string; databaseUrl?: string; rootPath?: string }): Promise<WorkspaceDescriptorDto> {
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
    patch: { name?: string; icon?: string; databaseUrl?: string | null; rootPath?: string; storagePreference?: 'default' | 'local' }
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

  async getDbSync(id: string): Promise<DbSyncStatusDto> {
    return fetchJsonOrThrow<DbSyncStatusDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}/db-sync`,
      { method: 'GET' },
      'Failed to fetch sync status'
    );
  },

  async postDbSync(
    id: string,
    body: { action: 'resolve' | 'sync-now' | 'rebuild-rag'; choice?: 'flush-local' | 'flush-db' | 'change-db' }
  ): Promise<any> {
    return fetchJsonOrThrow<any>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}/db-sync`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'Sync action failed'
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
  // §6/§8 per-channel pins. These are the server-side truth for pinned runtime
  // and pinned/default agent; localStorage is only a cache of them.
  async getChannelSettings(channelId: string) {
    return fetchJsonOrThrow<{
      channelId: string;
      pinnedRuntime: string | null;
      activeAgentId: string | null;
      defaultAgentId: string | null;
    }>(
      `${BACKEND_URL}/api/channels/${encodeURIComponent(channelId)}/settings`,
      { method: 'GET' },
      'Failed to fetch channel settings',
    );
  },
  async updateChannelSettings(
    channelId: string,
    patch: { pinnedRuntime?: string | null; activeAgentId?: string | null; defaultAgentId?: string | null },
  ) {
    return fetchJsonOrThrow(
      `${BACKEND_URL}/api/channels/${encodeURIComponent(channelId)}/settings`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
      'Failed to update channel settings',
    );
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
  // ART-1: list rows truncate patch/contentRef to 500 chars. Fetch the full
  // row before apply/revert so Apply never writes a truncated body.
  async getArtifact(id: string) {
    return await fetchJsonOrThrow(`${BACKEND_URL}/api/artifacts/${encodeURIComponent(id)}`, { method: 'GET' }, 'Failed to fetch artifact');
  },
  async search(q: string, limit = 20) {
    return fetchJsonOrThrow<{ query: string; channels: any[]; messages: any[] }>(
      `${BACKEND_URL}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { method: 'GET' },
      'Search failed'
    );
  },
  // AP-001/AP-005: explicit reuse flag alongside the legacy scope sentinel.
  async decideApproval(approvalId: string, decision: 'approved' | 'denied', scope?: string | null, reuse?: boolean) {
    return fetchJsonOrThrow<{ approval: unknown }>(
      `${BACKEND_URL}/api/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, scope: scope ?? null, reuse: reuse ?? (scope === 'reusable') }) },
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

  /** Root listing: carries the scope so the panel can name the folder and its source. */
  async getWorkspaceRoot(
    workspaceId: string,
    channelId?: string | null,
    root: MountRootDto = 'effective',
  ): Promise<MountScopeDto> {
    return fetchJsonOrThrow<MountScopeDto>(
      `${BACKEND_URL}/api/workspace/files?path=/&${mountQuery(workspaceId, channelId, root)}`,
      { method: 'GET' },
      'Failed to list the workspace root'
    );
  },

  /** Nested listing. The route returns a bare array below the root. */
  async getWorkspaceDirectory(
    path: string,
    workspaceId: string,
    channelId?: string | null,
    root: MountRootDto = 'effective',
  ): Promise<FileNodeDto[]> {
    return fetchJsonOrThrow<FileNodeDto[]>(
      `${BACKEND_URL}/api/workspace/files?path=${encodeURIComponent(path)}&${mountQuery(workspaceId, channelId, root)}`,
      { method: 'GET' },
      'Failed to list the directory'
    );
  },

  async getWorkspaceFileContent(
    path: string,
    workspaceId: string,
    channelId?: string | null,
    root: MountRootDto = 'effective',
  ): Promise<string> {
    const data = await fetchJsonOrThrow<{ content: string }>(
      `${BACKEND_URL}/api/workspace/files/content?path=${encodeURIComponent(path)}&${mountQuery(workspaceId, channelId, root)}`,
      { method: 'GET' },
      'Failed to read the file'
    );
    return data.content;
  },

  async saveWorkspaceFileContent(
    path: string,
    content: string,
    workspaceId: string,
    channelId?: string | null,
    root: MountRootDto = 'effective',
  ): Promise<void> {
    await fetchNoContentOrThrow(
      `${BACKEND_URL}/api/workspace/files/content`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, workspaceId, channelId: channelId ?? undefined, root }),
      },
      'Failed to save the file'
    );
  },

  /** The raw mount chain for one channel — what the mount control reads and writes. */
  async getChannelMount(channelId: string): Promise<MountInfoDto> {
    return fetchJsonOrThrow<MountInfoDto>(
      `${BACKEND_URL}/api/channels/${encodeURIComponent(channelId)}/mount`,
      { method: 'GET' },
      'Failed to read the channel mount'
    );
  },

  /** The raw mount record for one category — mirrors getChannelMount. */
  async getCategoryMount(categoryId: string): Promise<MountInfoDto> {
    return fetchJsonOrThrow<MountInfoDto>(
      `${BACKEND_URL}/api/categories/${encodeURIComponent(categoryId)}/mount`,
      { method: 'GET' },
      'Failed to read the category mount'
    );
  },

  /** The raw mount record for one workspace — mirrors getChannelMount. */
  async getWorkspaceMount(workspaceId: string): Promise<MountInfoDto> {
    return fetchJsonOrThrow<MountInfoDto>(
      `${BACKEND_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/mount`,
      { method: 'GET' },
      'Failed to read the workspace mount'
    );
  },

  /** Which root the panel actually lists for this (workspace, channel) pair. */
  async getEffectiveMount(workspaceId: string, channelId?: string | null): Promise<MountScopeDto> {
    const params = new URLSearchParams({ workspaceId });
    if (channelId) params.set('channelId', channelId);
    return fetchJsonOrThrow<MountScopeDto>(
      `${BACKEND_URL}/api/workspace/mount?${params.toString()}`,
      { method: 'GET' },
      'Failed to read the effective mount'
    );
  },

  /** The mount jail: host roots a mount path may live under. */
  async getAllowedRoots(workspaceId?: string | null): Promise<string[]> {
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    const data = await fetchJsonOrThrow<{ roots: string[] }>(
      `${BACKEND_URL}/api/fs/allowed-roots${qs}`,
      { method: 'GET' },
      'Failed to read the allowed mount roots'
    );
    return data.roots;
  },

  /** Attach or clear a mount at any of the three levels (§16). null clears it. */
  async setMount(
    target: 'channel' | 'category' | 'workspace',
    targetId: string,
    folderPath: string | null,
  ): Promise<MountInfoDto> {
    const segment = target === 'category' ? 'categories' : target === 'workspace' ? 'workspaces' : 'channels';
    return fetchJsonOrThrow<MountInfoDto>(
      `${BACKEND_URL}/api/${segment}/${encodeURIComponent(targetId)}/mount`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath }) },
      'Failed to update the mount'
    );
  },

  /** Browse the host filesystem inside the mount jail (the in-app fallback picker). */
  async browseFilesystem(path?: string | null, workspaceId?: string | null): Promise<FsBrowseDto> {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (workspaceId) params.set('workspaceId', workspaceId);
    const qs = params.toString();
    return fetchJsonOrThrow<FsBrowseDto>(
      `${BACKEND_URL}/api/fs/browse${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      'Failed to browse the filesystem'
    );
  },

  /** Live probe for one stored model module. Carries tenant headers; errors carry HTTP status. */
  async testModelModule(id: string): Promise<ModelTestResultDto> {
    return fetchJsonOrThrow<ModelTestResultDto>(
      `${BACKEND_URL}/api/modules/model/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
      'Failed to test the model connection'
    );
  },
};

export { readApiError };
