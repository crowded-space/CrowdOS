CREATE TYPE "public"."approval_risk_class" AS ENUM('install', 'network', 'destructive', 'git_push', 'db_write', 'general');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."swarm_task_status" AS ENUM('pending', 'running', 'completed', 'failed', 'blocked');--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'file';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'diff';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'report';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'citations';--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"args_preview" jsonb,
	"risk_class" "approval_risk_class" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" uuid NOT NULL,
	"child_run_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_template" text NOT NULL,
	"status" "swarm_task_status" DEFAULT 'pending' NOT NULL,
	"output_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "before_hash" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "after_hash" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "patch" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "content_ref" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;