-- Phase 7: Scale & observability hardening
-- SCL-2: pgvector semantic memory, SCL-3: per-run cost ledger

-- Ensure pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
-- SCL-3: token_usage_log runId for per-run cost rollup
ALTER TABLE "token_usage_log" ADD COLUMN IF NOT EXISTS "run_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_usage_log_run_idx" ON "token_usage_log" USING btree ("run_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "token_usage_log" ADD CONSTRAINT "token_usage_log_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- SCL-2: embedding columns on agent_memory_notes
-- Use text as storage for JSON-serialized vector to keep drizzle compatibility;
-- real pgvector column is added as vector(1536) where extension is available.
-- We add as text first, then attempt vector type alteration via conditional DDL.
ALTER TABLE "agent_memory_notes" ADD COLUMN IF NOT EXISTS "embedding" text;--> statement-breakpoint
ALTER TABLE "agent_memory_notes" ADD COLUMN IF NOT EXISTS "embedding_model" text;--> statement-breakpoint
ALTER TABLE "agent_memory_notes" ADD COLUMN IF NOT EXISTS "embedding_updated_at" timestamp with time zone;--> statement-breakpoint
-- Attempt to create HNSW index for vector similarity if extension type exists (best-effort)
DO $$ BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'vector';
  IF FOUND THEN
    BEGIN
      -- Add vector column variant for native similarity if not exists
      ALTER TABLE agent_memory_notes ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);
      CREATE INDEX IF NOT EXISTS agent_memory_notes_embedding_vec_idx ON agent_memory_notes USING hnsw (embedding_vec vector_cosine_ops);
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;--> statement-breakpoint
-- Ensure cost ledger view (optional convenience view for dashboard queries)
CREATE OR REPLACE VIEW cost_ledger_per_run AS
SELECT
  t.run_id AS run_id,
  t.agent_id,
  t.channel_id,
  t.model_module_id,
  SUM(t.prompt_tokens) AS total_prompt_tokens,
  SUM(t.completion_tokens) AS total_completion_tokens,
  SUM(t.total_tokens) AS total_tokens,
  SUM(CASE WHEN m.cost_per_1k IS NOT NULL THEN (m.cost_per_1k * (t.prompt_tokens + t.completion_tokens) / 1000.0) ELSE 0 END) AS total_cost_usd,
  MIN(t.timestamp) AS first_seen,
  MAX(t.timestamp) AS last_seen,
  COUNT(*) AS entries
FROM token_usage_log t
LEFT JOIN model_modules m ON t.model_module_id = m.id
GROUP BY t.run_id, t.agent_id, t.channel_id, t.model_module_id;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_notes_embedding_updated_idx" ON "agent_memory_notes" USING btree ("embedding_updated_at");--> statement-breakpoint
