-- 0027: agents.context_token_cap (AGT-008). The field flowed through zod
-- and the local store but had no PG column, so dual-tier reads lost it.
-- Rollback: DROP COLUMN context_token_cap.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "context_token_cap" integer;--> statement-breakpoint
