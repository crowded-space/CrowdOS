export type ThreadStatus = "active" | "archived" | "expired";

export interface Thread {
  id: string;
  channelId: string;
  parentMessageId: string | null;
  rootMessageId: string | null;
  title: string | null;
  createdBy: string;
  isEphemeral: boolean;
  status: ThreadStatus;
  expiresAt: Date | null;
  archivedAt: Date | null;
  messageCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateThreadInput {
  channelId: string;
  parentMessageId?: string | null;
  title?: string | null;
  createdBy: string;
  isEphemeral?: boolean;
  ttlHours?: number;
}

export interface UpdateThreadInput {
  title?: string | null;
  status?: ThreadStatus;
}

/**
 * THR-025: explicit tenant context for non-HTTP callers (workers/jobs/sockets).
 * `workspaceId` selects that workspace's effective Local/DB tier; `db` pins an
 * exact handle. Omitted → the ambient ALS handle or process-wide pool.
 */
export type threadCallContext = { workspaceId?: string | null; db?: any };
