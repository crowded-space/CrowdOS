-- 0025: thread-aware messages uniqueness (MSG-001/THR-002/XD-007).
--
-- The old messages_channel_sequence_idx on (channel_id, sequence_number) was
-- not thread-aware: channel messages and thread replies share the messages
-- table and both counters start at 1, so a thread reply collided with a
-- channel message and onConflictDoNothing silently dropped the reply from PG.
--
-- This migration adds a thread-aware unique index on
-- (channel_id, COALESCE(thread_id, ''), sequence_number) and drops the old
-- channel-scoped one. Pre-existing collisions are deduped keeping earliest.
-- Rollback: drop the new index, re-create the old one.

DELETE FROM "messages" a USING "messages" b
WHERE a.ctid > b.ctid
AND a."channel_id" = b."channel_id"
AND COALESCE(a."thread_id", '') = COALESCE(b."thread_id", '')
AND a."sequence_number" = b."sequence_number";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_channel_sequence_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_channel_thread_sequence_idx" ON "messages" ("channel_id", COALESCE("thread_id", ''), "sequence_number");--> statement-breakpoint
