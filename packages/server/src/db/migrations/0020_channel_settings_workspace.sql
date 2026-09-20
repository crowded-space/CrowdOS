-- 0020: channel_settings workspace scoping (CrowdOS §30).
--
-- channel_settings was keyed by channel_id alone (PRIMARY KEY), so settings
-- for a channel id had exactly one row database-wide. Two workspaces that each
-- own a channel with the same id could not keep independent pins or safety
-- policy. The table becomes keyed by (channel_id, workspace_id).
--
-- Backfill rule: an existing row takes the owning channel's workspace_id; a
-- channel with no workspace (legacy global, migration 0018 convention) keeps
-- the "default" placeholder, which is the same unscoped scope the rest of the
-- codebase uses ("?? default").

-- 1. Add the column nullable first so existing rows survive the ALTER.
ALTER TABLE "channel_settings" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint

-- 2. Backfill from the owning channel, else the documented default scope.
UPDATE "channel_settings" cs
   SET "workspace_id" = COALESCE(
         (SELECT c."workspace_id" FROM "channels" c WHERE c."id" = cs."channel_id"),
         'default'
       )
 WHERE cs."workspace_id" IS NULL;--> statement-breakpoint

-- 3. Normalize any drifted NULL back to the default scope, then enforce NOT NULL.
UPDATE "channel_settings" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint

-- 4. Swap the single-column PK for the composite (channel_id, workspace_id).
DO $$ BEGIN
  ALTER TABLE "channel_settings" DROP CONSTRAINT "channel_settings_pkey";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_pkey" PRIMARY KEY ("channel_id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- 5. FK to workspaces (cascade mirrors the other workspace-scoped tables).
DO $$ BEGIN
  ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- 6. Workspace-scoped lookups (settings reads always carry the workspace now).
CREATE INDEX IF NOT EXISTS "channel_settings_workspace_idx" ON "channel_settings" USING btree ("workspace_id");--> statement-breakpoint

