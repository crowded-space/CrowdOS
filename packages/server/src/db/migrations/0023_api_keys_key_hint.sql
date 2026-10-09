-- 0023: O(1) API key lookup hint.
--
-- verifyKey previously ran scrypt against EVERY active key (per-key random
-- salt forbids direct comparison), so authentication cost grew linearly with
-- stored keys and blew per-request budgets under load (observed 5s timeouts).
-- key_hint = sha256(plaintext key) hex: an instant equality lookup selects the
-- single candidate row, then scrypt confirms it. sha256(key) reveals nothing
-- about a 256-bit random key, so the hint is not a weakening.
--
-- Nullable with a unique index: legacy rows (and local-file rows) keep the
-- full-scan fallback path.
--
-- 2026-10-07 repair (db audit): 0011_drop_api_keys.sql drops "api_keys" and
-- its enum, so on a fresh DB this ALTER failed ("relation api_keys does not
-- exist") and, because drizzle applies the whole pending batch in one
-- transaction, EVERY migration after 0022 was rolled back (first-run desktop
-- migrate included). Recreate the 0002 shape (enum + table, idempotent)
-- before the ALTER so fresh and stale DBs converge.

DO $$ BEGIN
  CREATE TYPE "public"."api_key_role" AS ENUM('admin', 'operator', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key_hash" text NOT NULL,
  "key_hint" text,
  "label" text,
  "role" "api_key_role" DEFAULT 'viewer' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);--> statement-breakpoint

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_hint" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hint_idx" ON "api_keys" ("key_hint");
