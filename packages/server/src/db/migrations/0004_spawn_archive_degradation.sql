ALTER TABLE "agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived_reason" text;--> statement-breakpoint
ALTER TABLE "channel_index" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_index" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "archived_reason" text;--> statement-breakpoint
ALTER TABLE "task_files" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_files" ADD COLUMN "archived_reason" text;