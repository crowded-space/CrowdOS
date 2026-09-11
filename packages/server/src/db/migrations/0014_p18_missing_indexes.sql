-- P18: missing FK/lookup indexes (single high-ROI migration, idempotent).
-- First block: indexes already in schema.ts but never shipped as migration SQL.
-- Second block: 8 new indexes matching the new index() defs in schema.ts.
CREATE INDEX IF NOT EXISTS "runtime_overrides_target_agent_idx" ON "runtime_overrides" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_events_workspace_idx" ON "workspace_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_agents_workspace_idx" ON "workspace_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_workspace_idx" ON "artifacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "swarm_tasks_run_idx" ON "swarm_tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_parent_run_idx" ON "delegations" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_child_run_idx" ON "delegations" USING btree ("child_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_files_spawn_request_idx" ON "task_files" USING btree ("spawn_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_files_worker_idx" ON "task_files" USING btree ("worker_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_files_supervisor_idx" ON "task_files" USING btree ("spv_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compressed_summaries_channel_idx" ON "compressed_summaries" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_tasks_channel_idx" ON "scheduled_tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_tasks_active_next_run_idx" ON "scheduled_tasks" USING btree ("is_active","next_run");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_run_idx" ON "approval_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_status_idx" ON "approval_requests" USING btree ("status");
