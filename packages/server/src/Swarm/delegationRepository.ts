import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { delegations } from "../db/schema.js";

export interface DelegationRow {
  id: string;
  parentRunId: string;
  childRunId: string;
  depth: number;
  summary: string | null;
  createdAt: Date;
}

type DbDelegation = typeof delegations.$inferSelect;

function toRow(r: DbDelegation): DelegationRow {
  return {
    id: r.id,
    parentRunId: r.parentRunId,
    childRunId: r.childRunId,
    depth: r.depth,
    summary: r.summary ?? null,
    createdAt: r.createdAt,
  };
}

const memById = new Map<string, DelegationRow>();
const memByChild = new Map<string, DelegationRow>();
const memByParent = new Map<string, Set<string>>();

function isHermeticMode(): boolean {
  if (process.env.__SOCKET_FAKE_DB__ === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return true;
  return false;
}

export async function createDelegation(input: {
  parentRunId: string;
  childRunId: string;
  depth: number;
  summary?: string | null;
}): Promise<DelegationRow> {
  const id = `del_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;
  const now = new Date();
  const row: DelegationRow = {
    id,
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    depth: input.depth,
    summary: input.summary ?? null,
    createdAt: now,
  };

  if (isHermeticMode()) {
    memById.set(id, { ...row });
    memByChild.set(row.childRunId, { ...row });
    let set = memByParent.get(row.parentRunId);
    if (!set) {
      set = new Set();
      memByParent.set(row.parentRunId, set);
    }
    set.add(id);
    return { ...row };
  }

  try {
    const db = getDb();
    await db.insert(delegations).values({
      id: row.id,
      parentRunId: row.parentRunId,
      childRunId: row.childRunId,
      depth: row.depth,
      summary: row.summary,
      createdAt: row.createdAt,
    } as any);
    memById.set(id, { ...row });
    memByChild.set(row.childRunId, { ...row });
    let set = memByParent.get(row.parentRunId);
    if (!set) {
      set = new Set();
      memByParent.set(row.parentRunId, set);
    }
    set.add(id);
    return { ...row };
  } catch (err) {
    console.warn("[delegationRepository] createDelegation DB failed, falling back to memory:", (err as Error)?.message || err);
    memById.set(id, { ...row });
    memByChild.set(row.childRunId, { ...row });
    let set = memByParent.get(row.parentRunId);
    if (!set) {
      set = new Set();
      memByParent.set(row.parentRunId, set);
    }
    set.add(id);
    return { ...row };
  }
}

export async function getDelegationById(id: string): Promise<DelegationRow | null> {
  if (isHermeticMode()) {
    const r = memById.get(id);
    return r ? { ...r } : null;
  }
  try {
    const db = getDb();
    const [row] = await db.select().from(delegations).where(eq(delegations.id, id)).limit(1);
    if (!row) {
      const mem = memById.get(id);
      return mem ? { ...mem } : null;
    }
    const converted = toRow(row as DbDelegation);
    memById.set(id, { ...converted });
    memByChild.set(converted.childRunId, { ...converted });
    return converted;
  } catch {
    const mem = memById.get(id);
    return mem ? { ...mem } : null;
  }
}

export async function getDelegationByChild(childRunId: string): Promise<DelegationRow | null> {
  if (isHermeticMode()) {
    const r = memByChild.get(childRunId);
    return r ? { ...r } : null;
  }
  try {
    const db = getDb();
    const [row] = await db.select().from(delegations).where(eq(delegations.childRunId, childRunId)).limit(1);
    if (!row) {
      const mem = memByChild.get(childRunId);
      return mem ? { ...mem } : null;
    }
    const converted = toRow(row as DbDelegation);
    memById.set(converted.id, { ...converted });
    memByChild.set(childRunId, { ...converted });
    let set = memByParent.get(converted.parentRunId);
    if (!set) {
      set = new Set();
      memByParent.set(converted.parentRunId, set);
    }
    set.add(converted.id);
    return converted;
  } catch {
    const mem = memByChild.get(childRunId);
    return mem ? { ...mem } : null;
  }
}

export async function listDelegationsByParent(parentRunId: string): Promise<DelegationRow[]> {
  if (isHermeticMode()) {
    const ids = memByParent.get(parentRunId);
    if (!ids) return [];
    return [...ids].map((id) => ({ ...(memById.get(id) as DelegationRow) })).filter(Boolean);
  }
  try {
    const db = getDb();
    const rows = await db.select().from(delegations).where(eq(delegations.parentRunId, parentRunId));
    if (rows.length === 0) {
      const ids = memByParent.get(parentRunId);
      if (ids && ids.size > 0) return [...ids].map((id) => ({ ...(memById.get(id) as DelegationRow) }));
      return [];
    }
    const converted = (rows as DbDelegation[]).map(toRow);
    for (const c of converted) {
      memById.set(c.id, { ...c });
      memByChild.set(c.childRunId, { ...c });
      let set = memByParent.get(c.parentRunId);
      if (!set) {
        set = new Set();
        memByParent.set(c.parentRunId, set);
      }
      set.add(c.id);
    }
    return converted;
  } catch {
    const ids = memByParent.get(parentRunId);
    if (!ids) return [];
    return [...ids].map((id) => ({ ...(memById.get(id) as DelegationRow) }));
  }
}

export async function updateDelegationSummary(id: string, summary: string | null): Promise<DelegationRow | null> {
  if (isHermeticMode()) {
    const existing = memById.get(id);
    if (!existing) return null;
    existing.summary = summary;
    memById.set(id, { ...existing });
    memByChild.set(existing.childRunId, { ...existing });
    return { ...existing };
  }
  try {
    const db = getDb();
    const [row] = await db.update(delegations).set({ summary } as any).where(eq(delegations.id, id)).returning();
    if (!row) return null;
    const converted = toRow(row as DbDelegation);
    memById.set(id, { ...converted });
    memByChild.set(converted.childRunId, { ...converted });
    return converted;
  } catch (err) {
    console.warn("[delegationRepository] updateDelegationSummary DB failed, falling back to mem:", (err as Error)?.message || err);
    const existing = memById.get(id);
    if (!existing) return null;
    existing.summary = summary;
    memById.set(id, { ...existing });
    memByChild.set(existing.childRunId, { ...existing });
    return { ...existing };
  }
}

export async function listAllDelegations(): Promise<DelegationRow[]> {
  if (isHermeticMode()) {
    return [...memById.values()].map((r) => ({ ...r }));
  }
  try {
    const db = getDb();
    const rows = await db.select().from(delegations);
    return (rows as DbDelegation[]).map(toRow);
  } catch {
    return [...memById.values()].map((r) => ({ ...r }));
  }
}

export function resetDelegationRepositoryForTests(): void {
  memById.clear();
  memByChild.clear();
  memByParent.clear();
}
