-- 0029: Model Modules gain two new module-form selectors (Great Group 23b):
--   api_endpoint   — wire protocol the module speaks (google | anthropic |
--                    openai-completion | openai-responses); null = provider's
--                    native protocol. Honored today by the openai/custom
--                    providers choosing the OpenAI Responses wire protocol.
--   thinking_level — reasoning depth knob (none|minimal|low|medium|high|xhigh|
--                    max); "none"/null = provider default.
-- Free-text (not enums) on purpose: the provider APIs evolve each value set;
-- the zod validator at the module boundary is the type gate.
-- Rollback: DROP COLUMN api_endpoint, thinking_level.
ALTER TABLE "model_modules" ADD COLUMN IF NOT EXISTS "api_endpoint" text;--> statement-breakpoint
ALTER TABLE "model_modules" ADD COLUMN IF NOT EXISTS "thinking_level" text;
