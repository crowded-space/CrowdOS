// ─── Workspace Manager ──────────────────────────────────────────────
// Manages workspace lifecycle, agent mounting, and VFS access.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { eq, and, ilike } from "drizzle-orm";

import { getDb, withTransaction } from "../shared/config/database.js";
import { workspaces, workspaceAgents, workspaceEvents } from "../db/schema.js";
import { LocalVFS } from "../vfs/vfs-gate.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";
import type {
  Workspace,
  WorkspaceAgentSession,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceStatus,
  CreateWorkspaceInput,
  MountAgentInput,
  WorkspacePermissions,
  RuntimeConstraints,
  VFSPermissions,
} from "./workspace-types.js";

const DEFAULT_PERMISSIONS: WorkspacePermissions = {
  network: false,
  shell: false,
  maxAgents: 8,
};

const DEFAULT_CONSTRAINTS: RuntimeConstraints = {
  networkAccess: false,
  shellExecution: true,
  memoryLimitMb: 512,
  cpuLimit: 1,
};

const DEFAULT_VFS_PERMISSIONS: VFSPermissions = {
  read: true,
  write: false,
  execute: false,
};

export class WorkspaceManager {
  sandboxRoot: string;
  eventBroker?: EventBroker;

  constructor(sandboxRoot: string, eventBroker?: EventBroker) {
    this.sandboxRoot = sandboxRoot;
    this.eventBroker = eventBroker;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const db = getDb();
    const id = `ws_${randomUUID().slice(0, 8)}`;
    const rootPath = join(this.sandboxRoot, id).replace(/\\/g, "/");

    const permissions: WorkspacePermissions = {
      ...DEFAULT_PERMISSIONS,
      ...input.permissions,
    };
    const constraints: RuntimeConstraints = {
      ...DEFAULT_CONSTRAINTS,
      ...input.constraints,
    };

    const now = new Date();

    // Insert + INITIALIZING in one txn so a crash between them never
    // leaves a CREATED orphan; VFS failure below compensates with
    // delete (+ rm dir) so no INITIALIZING orphan survives.
    await withTransaction(async (tx: any) => {
      await tx.insert(workspaces).values({
        id,
        name: input.name,
        ownerId: input.ownerId ?? "human_operator",
        status: "CREATED",
        rootPath,
        permissions,
        constraints,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(workspaces)
        .set({ status: "INITIALIZING", updatedAt: new Date() })
        .where(eq(workspaces.id, id));
    });

    // Auto-create VFS and initialize folders & nodes structure
    const vfs = new LocalVFS({
      workspaceId: id,
      workspaceRoot: rootPath,
      actorId: input.ownerId ?? "human_operator",
    });
    try {
      await vfs.initialize();
    } catch (err) {
      try { await db.delete(workspaces).where(eq(workspaces.id, id)); } catch { /* ignore rollback errors */ }
      try { await fs.rm(rootPath, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }

    // Transition to ACTIVE
    await db
      .update(workspaces)
      .set({ status: "ACTIVE", updatedAt: new Date() })
      .where(eq(workspaces.id, id));

    // Emit event
    await this.emitEvent(id, "workspace.created", undefined, undefined, { name: input.name });

    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error(`Failed to create workspace ${id}`);
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const db = getDb();
    const row = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
    });
    return row ? row : null;
  }

  async listWorkspaces(opts?: { search?: string; limit?: number; offset?: number }): Promise<Workspace[]> {
    const db = getDb();
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 100), 1), 200);
    const offset = Math.max(Math.floor(opts?.offset ?? 0), 0);
    const search = opts?.search?.trim();
    const rows = await db.query.workspaces.findMany({
      where: search ? ilike(workspaces.name, `%${search}%`) : undefined,
      limit,
      offset,
    });
    return rows;
  }

  async deleteWorkspace(id: string): Promise<void> {
    const db = getDb();
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace ${id} not found`);

    // Terminate first if active
    if (workspace.status === "ACTIVE" || workspace.status === "PAUSED") {
      await db
        .update(workspaces)
        .set({ status: "TERMINATED", updatedAt: new Date() })
        .where(eq(workspaces.id, id));
    }

    // Clean up sandbox directory
    try {
      await fs.rm(workspace.rootPath, { recursive: true, force: true });
    } catch {
      // Directory may already be gone
    }

    // Delete DB record (cascades to nodes, events, agents, artifacts)
    await db.delete(workspaces).where(eq(workspaces.id, id));
    this.eventBroker?.emit("agent:status", { agentId: "system", status: "idle" });
  }

  async updateWorkspaceStatus(id: string, status: WorkspaceStatus): Promise<Workspace> {
    const db = getDb();
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace ${id} not found`);

    // Validate state transitions
    const validTransitions: Record<WorkspaceStatus, WorkspaceStatus[]> = {
      CREATED: ["INITIALIZING"],
      INITIALIZING: ["ACTIVE"],
      ACTIVE: ["PAUSED", "TERMINATED"],
      PAUSED: ["ACTIVE", "TERMINATED"],
      TERMINATED: ["ARCHIVED"],
      ARCHIVED: [],
    };
    const allowed = validTransitions[workspace.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(`Invalid transition: ${workspace.status} → ${status}`);
    }

    await db
      .update(workspaces)
      .set({ status, updatedAt: new Date() })
      .where(eq(workspaces.id, id));

    const updated = await this.getWorkspace(id);
    if (!updated) throw new Error(`Workspace ${id} not found after update`);
    return updated;
  }

  // ─── Agent Mounting ──────────────────────────────────────────────────

  async mountAgent(workspaceId: string, input: MountAgentInput): Promise<WorkspaceAgentSession> {
    const db = getDb();
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    if (workspace.status !== "ACTIVE") throw new Error(`Workspace ${workspaceId} is not ACTIVE`);

    // Check max agents
    const existingSessions = await db.query.workspaceAgents.findMany({
      where: eq(workspaceAgents.workspaceId, workspaceId),
    });
    if (existingSessions.length >= workspace.permissions.maxAgents) {
      throw new Error(
        `Workspace ${workspaceId} has reached max agents (${workspace.permissions.maxAgents})`,
      );
    }

    // Check if already mounted
    const alreadyMounted = existingSessions.find((s) => s.agentId === input.agentId);
    if (alreadyMounted) {
      throw new Error(`Agent ${input.agentId} is already mounted to workspace ${workspaceId}`);
    }

    const session: WorkspaceAgentSession = {
      id: `wsa_${randomUUID().slice(0, 8)}`,
      workspaceId,
      agentId: input.agentId,
      scope: input.scope ?? "shared",
      permissions: { ...DEFAULT_VFS_PERMISSIONS, ...input.permissions },
      createdAt: new Date(),
    };

    await db.insert(workspaceAgents).values(session);
    await this.emitEvent(workspaceId, "agent.joined", input.agentId, undefined, { scope: session.scope });
    return session;
  }

  async unmountAgent(workspaceId: string, agentId: string): Promise<void> {
    const db = getDb();
    const session = await db.query.workspaceAgents.findFirst({
      where: and(
        eq(workspaceAgents.workspaceId, workspaceId),
        eq(workspaceAgents.agentId, agentId),
      ),
    });
    if (!session) throw new Error(`Agent ${agentId} is not mounted to workspace ${workspaceId}`);

    await db.delete(workspaceAgents).where(eq(workspaceAgents.id, session.id));
    await this.emitEvent(workspaceId, "agent.left", agentId);
  }

  async getAgentSessions(workspaceId: string): Promise<WorkspaceAgentSession[]> {
    const db = getDb();
    const rows = await db.query.workspaceAgents.findMany({
      where: eq(workspaceAgents.workspaceId, workspaceId),
    });
    return rows;
  }

  // ─── VFS Access ──────────────────────────────────────────────────────

  getVFS(workspaceId: string, workspace: Workspace, actorId: string): LocalVFS {
    return new LocalVFS({
      workspaceId,
      workspaceRoot: workspace.rootPath,
      actorId,
      onEvent: (type: string, path: string, metadata?: Record<string, unknown>) => {
        this.emitEvent(workspaceId, type as WorkspaceEventType, actorId, path, metadata);
      },
    });
  }

  // ─── Events ──────────────────────────────────────────────────────────

  async emitEvent(
    workspaceId: string,
    type: WorkspaceEventType,
    agentId?: string,
    path?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const db = getDb();

    // Persist event
    await db.insert(workspaceEvents).values({
      id: `evt_${randomUUID().slice(0, 8)}`,
      workspaceId,
      type,
      agentId: agentId ?? null,
      path: path ?? null,
      payload: metadata ?? {},
      createdAt: new Date(),
    });

    // Forward to EventBroker if available (future: workspace-specific events)
    // For now we use the existing broker to broadcast workspace changes
  }

  async getEvents(workspaceId: string, limit = 50): Promise<WorkspaceEvent[]> {
    const db = getDb();
    const rows = await db.query.workspaceEvents.findMany({
      where: eq(workspaceEvents.workspaceId, workspaceId),
      orderBy: (table: any, { desc }: any) => [desc(table.createdAt)],
      limit,
    });
    return rows;
  }
}
