-- 0019: drop NO-VFS residue (CrowdOS §16 NO VFS). LocalVFS is truth; these
-- tables were never written by code (see vfs/local-vfs.ts) and imply a DB
-- mirror that must not exist.
DROP TABLE IF EXISTS "workspace_nodes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "workspace_events" CASCADE;--> statement-breakpoint
