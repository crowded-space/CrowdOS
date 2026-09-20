-- 0018: agents.workspace_id (nullable) — CrowdOS §1/30 per-workspace isolation.
-- Same name = separate instance per workspace. Null = legacy global row
-- (visible everywhere until backfilled). Local is truth; PG is replica.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_workspace_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
-- Drop global name uniqueness; enforce per-workspace uniqueness instead.
DROP INDEX IF EXISTS "agents_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_workspace_name_idx" ON "agents" USING btree ("workspace_id", "name");--> statement-breakpoint
-- Backfill legacy rows to the default workspace where it exists; elsewhere keep null (global).
UPDATE "agents" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL AND EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = 'default');--> statement-breakpoint
