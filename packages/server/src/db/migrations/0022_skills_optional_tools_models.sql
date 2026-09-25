-- 0022: persist optionalTools/recommendedModels on skills.
--
-- The API contract (skill-validators.ts, skill-types.ts) has accepted
-- optionalToolIds and recommendedModels since the Skills domain was cut, but
-- the skills table had no columns for them, so create() and update() silently
-- dropped both fields -- a skill saved with optional tools or recommended
-- models read back with empty arrays (silent data loss on every save).
--
-- Backfill: none needed. Columns are NOT NULL DEFAULT '[]', and mapSkill
-- already defaulted missing values to [] on read, so pre-migration rows
-- behave identically.

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "optional_tools" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "recommended_models" jsonb NOT NULL DEFAULT '[]'::jsonb;

