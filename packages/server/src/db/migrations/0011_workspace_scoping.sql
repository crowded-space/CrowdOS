-- Workspace scoping: tenant boundary columns (destructive-friendly backfill to "default")
-- Ensure the legacy default workspace row exists before FK backfill
INSERT INTO "workspaces" ("id", "name", "owner_id", "status", "root_path", "permissions", "constraints", "metadata", "created_at", "updated_at")
VALUES ('default', 'Default Workspace', 'human_operator', 'ACTIVE', 'sandbox/default', '{"network":false,"shell":false,"maxAgents":8}'::jsonb, '{"networkAccess":false,"shellExecution":true,"memoryLimitMb":512,"cpuLimit":1}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Categories: add workspace_id, backfill, enforce NOT NULL + FK + index
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
UPDATE "categories" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "categories" ADD CONSTRAINT "categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_workspace_idx" ON "categories" USING btree ("workspace_id");--> statement-breakpoint
-- Channels: add workspace_id, backfill, enforce NOT NULL + FK + index
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
-- Messages: add workspace_id (denormalized from channel), backfill, enforce NOT NULL + FK + index
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
UPDATE "messages" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_workspace_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
-- Durable events: nullable workspace_id (NULL = truly global), FK + index
ALTER TABLE "durable_events" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "durable_events" ADD CONSTRAINT "durable_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "durable_events_workspace_idx" ON "durable_events" USING btree ("workspace_id");--> statement-breakpoint
-- Runs: backfill nulls, enforce NOT NULL + FK + index
UPDATE "runs" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_workspace_idx" ON "runs" USING btree ("workspace_id");--> statement-breakpoint
