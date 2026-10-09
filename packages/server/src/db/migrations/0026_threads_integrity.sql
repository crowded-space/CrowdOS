-- 0026: threads integrity (THR-004/THR-005).
-- THR-004: partial unique index on parent_message_id so concurrent creates
-- cannot race into duplicates (service catches violation, returns existing).
-- THR-005: delete rule is SET NULL at the service layer (replies survive as
-- channel messages); no FK change since messages.thread_id is plain text.
-- Rollback: DROP INDEX threads_parent_message_idx.
CREATE UNIQUE INDEX IF NOT EXISTS "threads_parent_message_idx" ON "threads" ("parent_message_id") WHERE "parent_message_id" IS NOT NULL;--> statement-breakpoint
