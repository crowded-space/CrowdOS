CREATE TABLE "runs_compensation" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"tool_name" text NOT NULL,
	"target_path" text NOT NULL,
	"inverse_op" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "runs_compensation" ADD CONSTRAINT "runs_compensation_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_compensation_run_seq_idx" ON "runs_compensation" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_compensation_run_idx" ON "runs_compensation" USING btree ("run_id");