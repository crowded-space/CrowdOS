-- 0021: canon virtual mount set on channels/categories (CrowdOS §16 chain).
--
-- The canon fsMounts descriptor { scope, mode, mounts[] } has lived on the
-- local tier (vfs/.crowdos/{categories,channels}.json) since 2026-09-22, but
-- the PG replica had no column, so dualWrite committed locally and then
-- converged a row WITHOUT fsMounts — virtual mounts silently vanished on any
-- PG-configured deployment. The column is text (mode "json") so the descriptor
-- stays schema-agnostic, mirroring the local tier's JSON-file rows.
--
-- Backfill: existing PG rows have no descriptor; the local tier defaults
-- rows to "inherit" on read (channel-local-store.ts), so NULL keeps that
-- read-side defaulting intact rather than inventing a stored value.

ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "fs_mounts" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "fs_mounts" jsonb;
