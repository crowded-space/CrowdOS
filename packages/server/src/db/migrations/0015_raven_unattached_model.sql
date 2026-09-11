-- 0015: allow unattached ModelModule (Raven default has no pinned model).
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_model_module_id_model_modules_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model_module_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agents" ADD CONSTRAINT "agents_model_module_id_model_modules_id_fk" FOREIGN KEY ("model_module_id") REFERENCES "public"."model_modules"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
