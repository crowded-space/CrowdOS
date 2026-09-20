-- 0017: channel_settings pins (§6-8) — per-channel composer state.
-- Nullable: NULL means unset (Auto / no pinned agent / no channel default).
ALTER TABLE "channel_settings" ADD COLUMN IF NOT EXISTS "pinned_runtime" text;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN IF NOT EXISTS "active_agent_id" text;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN IF NOT EXISTS "default_agent_id" text;--> statement-breakpoint
