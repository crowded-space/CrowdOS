CREATE TYPE "public"."run_status" AS ENUM('running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_run_id" uuid,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text,
	"runtime_type" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"error_code" text,
	"checkpoint_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_channel_idx" ON "runs" USING btree ("channel_id");