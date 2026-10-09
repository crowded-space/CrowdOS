-- DB-004: drop the dead approval_requests.scope_hash column + its index.
--
-- 0012 added "scope_hash" (line 12) and "approval_requests_scope_hash_idx"
-- (line 76), but schema.ts and approvals/approval-repository.ts read only the
-- "scope" column (eq(approvalRequests.scope, scopeHash)) - the column stayed
-- NULL on every migrated DB and no query reads it, so both are dead weight
-- and schema/migration drift.
--
-- approval_grants.scope_hash (0012:52) is a DIFFERENT table, is live, and
-- must stay untouched.
--
-- Idempotent (IF EXISTS guards) like the rest of the 0012+ hand-written set,
-- so a retried pending batch heals instead of throwing.
DROP INDEX IF EXISTS "approval_requests_scope_hash_idx";--> statement-breakpoint
ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "scope_hash";
