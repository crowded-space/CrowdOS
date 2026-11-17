-- 0030: channels.description (UI audit §2.14). The create form collected a
-- topic description, but the channels domain had no description field — the
-- POST body dropped it and the client invented a shared placeholder instead.
-- Nullable: pre-existing rows keep working with no description.
-- Rollback: ALTER TABLE "channels" DROP COLUMN "description".
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
