-- 0016: messages.workspace_id (nullable) — aligns code with DB reality.
-- An earlier (since superseded) workspace-scoping migration left some
-- databases with messages.workspace_id NOT NULL while no schema, bootstrap,
-- migration, or writer knows the column. Nullable matches the
-- categories/channels precedent: writers omit it until threaded through.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
-- Normalize drifted databases back to the nullable design (no-op elsewhere).
ALTER TABLE "messages" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_workspace_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
