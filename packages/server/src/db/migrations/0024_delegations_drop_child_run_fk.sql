-- 0024: delegations.child_run_id no longer FK-references runs.id.
--
-- The central dispatcher records one delegation row per swarm TASK, minting a
-- fresh randomUUID() child id (uuid column type still satisfied). Those child
-- ids are delegation tokens, not run rows — with the FK in place every prod
-- INSERT failed with FK violation, the repository logged a warning and fell
-- back to process memory, so guard data silently vanished on restart.
--
-- Only the child FK is dropped; parent_run_id keeps its FK (parent is always a
-- real run) and child_run_id stays uuid NOT NULL. ON DELETE cascade for child
-- runs is lost by design: dispatcher children are not runs; parent deletion
-- still cascades via the parent FK.
--
-- Known drift: db/schema.ts still declares .references(() => runs.id) on this
-- column (schema.ts is outside this task's editable set). Reconcile there when
-- schema.ts is next touched so drizzle-kit generate does not re-add the FK.

ALTER TABLE "delegations" DROP CONSTRAINT IF EXISTS "delegations_child_run_id_runs_id_fk";--> statement-breakpoint
