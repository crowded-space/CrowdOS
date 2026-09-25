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

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_hint" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hint_idx" ON "api_keys" ("key_hint");
