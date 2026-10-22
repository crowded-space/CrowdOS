// ─── Scheduler local store (A1 · local file tier) ─────────────────────
// File truth for scheduled tasks in the local tier (QUEUE_MODE=inline, no
// BullMQ). A schedule is written here BEFORE it is armed, so an armed timer
// that dies with the process is still known to the next boot:
//
//   <workspaceFolder>/vfs/.crowdos/scheduler/scheduled_tasks.json
//
// The row carries the next fire time so the boot re-arm can recalibrate
// against the wall clock (A2). This store owns that calculation: the Tools
// domain states the intent (cron OR delay), the Queue domain decides when
// it next runs.
//
// ponytail: one JSON array per workspace rewritten under the shared per-file
// lock; local mode is single-process (shared/core/local-file.ts). Read-then-
// mutate in the update paths is not atomic across the two calls — the
// scheduler is the only writer, so the window is closed in practice.

import {
  candidateWorkspaceScopes,
  mutateJsonArray,
  readJsonArray,
} from "../shared/core/local-file.js";

const INDEX_FILE = "scheduler/scheduled_tasks.json";

/** One persisted schedule. `nextRun` is the next fire time (ISO). */
export type scheduleRow = {
  id: string;
  channelId: string;
  workspaceId: string;
  task: string;
  message: string | null;
  targetAgentId: string | null;
  /**
   * Who wrote the wake message. An agent that schedules its own next wake
   * records itself here, so the wake is delivered in ITS words and carries its
   * sender id - the message is the agent's, not the scheduler's. Null for a
   * task created by the operator (the watchdog): the wake is then a system
   * message.
   */
  authorAgentId: string | null;
  cron: string | null;
  nextRun: string | null;
  createdAt: string;
  isActive: boolean;
};

/** What a caller states about a schedule; `nextRun` is computed here. */
export type scheduleInput = {
  id: string;
  channelId: string;
  workspaceId: string;
  task: string;
  message?: string | null;
  targetAgentId?: string | null;
  /** The agent whose words the wake message is, when it scheduled itself. */
  authorAgentId?: string | null;
  /** Cron expression. Only the every-N-minutes form is tracked locally. */
  cron?: string | null;
  /** One-shot delay in seconds (ignored when `cron` is set). */
  delaySeconds?: number | null;
};

/** setTimeout overflows past 2^31-1 ms (~24.8d) and fires in 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

// Next occurrence of a cron, strictly after `from`.
//
// Two forms are understood, and they are the two the inline scheduler
// accepts: an every-N-minutes expression (N 1..60) and an every-N-hours
// expression - minute M, hour step H, H 1..24 - written "M step-H * * *".
// Any other expression returns null: that schedule is not tracked locally
// (BullMQ owns it in bullmq mode, and the inline path rejects it outright).
export function nextCronOccurrence(cron: string, from: Date): string | null {
  const trimmed = cron.trim();

  // Hourly form: "M */H * * *" (minute M, every H hours) - the 2-4h
  // watchdog cadence. "*/N * * * *" with N > 60 cannot express this: the
  // minute field only reaches 59, so N=120 would silently fire hourly.
  const hourly = /^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/.exec(trimmed);
  if (hourly) {
    const minute = Number(hourly[1]);
    const hours = Number(hourly[2]);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return null;
    const d = new Date(from.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(minute);
    if (d.getTime() <= from.getTime()) d.setHours(d.getHours() + 1);
    // Cron hours are the multiples of H (0, H, 2H…) within the day.
    while (d.getHours() % hours !== 0) d.setHours(d.getHours() + 1);
    return d.toISOString();
  }

  const m = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(trimmed);
  if (!m) return null;
  const step = Number(m[1]);
  if (!Number.isInteger(step) || step < 1 || step > 60) return null;

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  const startMinute = d.getMinutes();
  // Cron minutes inside an hour are the multiples of `step` (0, step, 2*step…).
  let candidate = -1;
  for (let minute = startMinute; minute < 60; minute += 1) {
    if (minute % step === 0) {
      candidate = minute;
      break;
    }
  }
  if (candidate === -1) {
    // No multiple left in this hour → the next hour's minute 0.
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d.toISOString();
  }
  d.setMinutes(candidate);
  if (d.getTime() <= from.getTime()) {
    // On the boundary (or the seconds truncated into it) → the next one.
    const next = candidate + step;
    if (next >= 60) d.setHours(d.getHours() + 1, 0, 0, 0);
    else d.setMinutes(next);
  }
  return d.toISOString();
}

/** Next fire time for a schedule intent (cron wins over delay). */
export function nextRunFor(input: scheduleInput, now: Date = new Date()): string | null {
  const cron = input.cron?.trim();
  if (cron) return nextCronOccurrence(cron, now);
  const seconds = Number(input.delaySeconds ?? 0);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.min(Math.max(0, Math.round(seconds * 1000)), MAX_TIMER_MS);
  return new Date(now.getTime() + ms).toISOString();
}

/** Persist (upsert) a schedule and return the stored row. */
export async function localSaveSchedule(
  input: scheduleInput,
  now: Date = new Date(),
): Promise<scheduleRow> {
  const row: scheduleRow = {
    id: input.id,
    channelId: input.channelId,
    workspaceId: input.workspaceId,
    task: input.task,
    message: input.message ?? null,
    targetAgentId: input.targetAgentId ?? null,
    authorAgentId: input.authorAgentId ?? null,
    cron: input.cron?.trim() || null,
    nextRun: nextRunFor(input, now),
    createdAt: now.toISOString(),
    isActive: true,
  };
  await mutateJsonArray<scheduleRow>(
    INDEX_FILE,
    (rows) => {
      const idx = rows.findIndex((r) => r.id === row.id);
      if (idx === -1) rows.push(row);
      else rows[idx] = row;
    },
    row.workspaceId,
  );
  return row;
}

/**
 * Active schedules. A named workspace reads only its own file; an unscoped
 * call fans out over the candidate workspace scopes (boot re-arm).
 */
export async function localListActiveSchedules(
  workspaceId?: string | null,
): Promise<scheduleRow[]> {
  const scopes = workspaceId ? [workspaceId] : candidateWorkspaceScopes();
  const out: scheduleRow[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const rows = await readJsonArray<scheduleRow>(INDEX_FILE, scope);
    for (const row of rows) {
      if (!row.isActive) continue;
      // Scopes can overlap (a store-dir override maps every scope to the same
      // file), so one row must not be counted — or fired — once per scope.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // An unscoped read still reports the owning workspace on each row.
      out.push({ ...row, workspaceId: row.workspaceId ?? scope });
    }
  }
  return out;
}

/** Update the next fire time of an active schedule. */
export async function localUpdateNextRun(
  id: string,
  nextRun: string | null,
  workspaceId?: string | null,
): Promise<boolean> {
  const scopes = workspaceId ? [workspaceId] : candidateWorkspaceScopes();
  for (const scope of scopes) {
    const rows = await readJsonArray<scheduleRow>(INDEX_FILE, scope);
    if (!rows.some((r) => r.id === id)) continue;
    await mutateJsonArray<scheduleRow>(
      INDEX_FILE,
      (list) => {
        const row = list.find((r) => r.id === id);
        if (row) row.nextRun = nextRun;
      },
      scope,
    );
    return true;
  }
  return false;
}

/** Mark a schedule inactive (it stays in the file as history). */
export async function localDeactivateSchedule(
  id: string,
  workspaceId?: string | null,
): Promise<boolean> {
  const scopes = workspaceId ? [workspaceId] : candidateWorkspaceScopes();
  for (const scope of scopes) {
    const rows = await readJsonArray<scheduleRow>(INDEX_FILE, scope);
    if (!rows.some((r) => r.id === id)) continue;
    await mutateJsonArray<scheduleRow>(
      INDEX_FILE,
      (list) => {
        const row = list.find((r) => r.id === id);
        if (row) row.isActive = false;
      },
      scope,
    );
    return true;
  }
  return false;
}
