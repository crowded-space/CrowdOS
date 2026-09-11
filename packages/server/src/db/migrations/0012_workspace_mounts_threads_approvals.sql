-- ponytail: fully re-runnable (IF NOT EXISTS / duplicate_object guards) so a
-- previously aborted partial apply heals on retry instead of throwing forever.
DO $$ BEGIN CREATE TYPE "public"."approval_scope_type" AS ENUM('once', 'session', 'workspace', 'global', 'channel', 'reusable'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."thread_status" AS ENUM('active', 'archived', 'expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "icon" text DEFAULT 'crow-indigo-circle' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "folder_path" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "folder_path" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "scope_type" "approval_scope_type" DEFAULT 'once' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "scope_hash" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "channel_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"parent_message_id" text,
	"root_message_id" text,
	"title" text,
	"created_by" text NOT NULL,
	"is_ephemeral" boolean DEFAULT true NOT NULL,
	"status" "thread_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_sequences" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_settings" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"fs_policy" jsonb DEFAULT '{"requireApprovalFor":["delete","execute"],"autoAllowPaths":[],"blockPaths":[]}'::jsonb NOT NULL,
	"safety_settings" jsonb DEFAULT '{"defaultApprovalScope":"session","allowInheritCategoryMount":true}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_safety_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"fs_policy" jsonb DEFAULT '{"requireApprovalFor":["delete","execute"],"autoAllowPaths":[],"blockPaths":[]}'::jsonb NOT NULL,
	"approval_defaults" jsonb DEFAULT '{"defaultScope":"session","allowGlobalAlwaysAllow":false}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"scope_hash" text NOT NULL,
	"scope_type" "approval_scope_type" NOT NULL,
	"workspace_id" text,
	"channel_id" text,
	"granted_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "threads" ADD CONSTRAINT "threads_root_message_id_messages_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "thread_sequences" ADD CONSTRAINT "thread_sequences_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_safety_settings" ADD CONSTRAINT "workspace_safety_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_workspace_idx" ON "categories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_folder_idx" ON "channels" USING btree ("folder_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_ts_seq_idx" ON "messages" USING btree ("thread_id","timestamp" DESC,"sequence_number" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_channel_idx" ON "threads" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_status_idx" ON "threads" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_expires_idx" ON "threads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_run_idx" ON "approval_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_channel_idx" ON "approval_requests" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_scope_hash_idx" ON "approval_requests" USING btree ("scope_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_status_idx" ON "approval_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_grants_tool_hash_idx" ON "approval_grants" USING btree ("tool_name","scope_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_grants_channel_idx" ON "approval_grants" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_grants_workspace_idx" ON "approval_grants" USING btree ("workspace_id");--> statement-breakpoint
UPDATE "categories" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
