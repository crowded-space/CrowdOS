-- Perf P2 UX Optimization: missing composite indexes + pg_trgm for search + scope fanout deps
CREATE INDEX IF NOT EXISTS "messages_channel_ts_seq_idx" ON "messages" USING btree ("channel_id","timestamp" DESC NULLS LAST,"sequence_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_category_idx" ON "channels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_archived_position_idx" ON "channels" USING btree ("archived_at","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_states_agent_idx" ON "runtime_states" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "durable_events_created_at_idx" ON "durable_events" USING btree ("created_at");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_name_trgm_idx" ON "channels" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON "messages" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
