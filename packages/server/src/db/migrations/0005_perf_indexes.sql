CREATE INDEX "agent_memory_notes_agent_lifecycle_idx" ON "agent_memory_notes" USING btree ("agent_id","lifecycle_status","note_timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_channel_timestamp_idx" ON "messages" USING btree ("channel_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spawn_requests_status_idx" ON "spawn_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "token_usage_log_timestamp_idx" ON "token_usage_log" USING btree ("timestamp");