ALTER TYPE "public"."run_status" ADD VALUE 'created' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'queued' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'starting' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'waiting_for_tool' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'waiting_for_approval' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'retrying' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'compacting' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'completing' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'verifying' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'cancelling';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'orphaned';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'resumable';--> statement-breakpoint
CREATE TABLE "channel_sequences" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_update_log" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "memory_update_log" ADD COLUMN "action" text DEFAULT 'update' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "channel_sequences" ADD CONSTRAINT "channel_sequences_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;