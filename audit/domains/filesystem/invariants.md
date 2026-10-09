# Filesystem Domain — Invariants (Phase 3)

## Must-hold invariants (with status)
| # | Invariant | Status | Evidence |
|---|---|---|---|
| I1 | Every op resolves through resolveWorkspacePath before I/O | HOLDS | local-filesystem.ts:82, each op calls this.resolve() |
| I2 | Resolved path stays inside real root (lexical + realpath) | HOLDS with caveat | path-guard.ts:130-169; caveat: 60s root realpath cache (F-05) |
| I3 | Hidden = display-only; naming a hidden path still works | HOLDS | entry-visibility.test.ts:109-124 (pinned) |
| I4 | list output == visible subset of disk, dirs-first then name | HOLDS | entry-visibility.test.ts:135-151; local-filesystem.ts:184-189 |
| I5 | Text read >1MB carries [TRUNCATED] marker | HOLDS | local-filesystem.ts:88-94 |
| I6 | stat is disk-only: checksum null, actors = ctor actorId | HOLDS | local-filesystem.ts:204-208 |
| I7 | mkdir/initialize idempotent | HOLDS | recursive mkdir; initialize re-runs; ws.json written only when missing (local-filesystem.ts:65) |
| I8 | delete on missing throws; exists returns false | HOLDS | local-filesystem.ts:134 (stat throws), 212-219 |
| I9 | No DB/table access from this domain | HOLDS | grep: no db imports; schema.ts:503 confirms 0019 drop |
| I10 | Facade thin; only gate importable cross-domain | HOLDS | check-gates.mjs 0 violations; gate is re-export-only |
| I11 | Listing a directory never fails because one entry is broken | VIOLATED | F-01: fs.stat inside list batch (local-filesystem.ts:171) — dangling symlink ⇒ whole list() rejects ENOENT (probe: LIST_FAIL ENOENT) |
| I12 | Binary reads signal truncation | VIOLATED | F-02: readBinary silently slices at 1MB (local-filesystem.ts:100-112) |
| I13 | Rename/delete of a subtree atomic wrt cached consumers | NOT HELD | no locking/atomic-rename writes (local-filesystem.ts:115-124); doc admits (Domain Spec Gaps) |
| I14 | onEvent fires for every mutation | VIOLATED (partial) | F-08: mkdir emits nothing; write to .crowdos/workspace.json inside initialize does emit (it calls this.write) |
| I15 | Panel root and tool root agree | HOLDS via callers | routes/filesystem.ts:17-19 uses channelMountGate.scope; pinned by channel-mount-gate.test.ts:379 (panel/tool agreement) |

## Edge-case findings from probes (Phase 2, live)
- isPathSafe("...") = false, ("..foo") = false → over-rejection: a file literally named "..." or "..foo" is unaddressable (path-guard.ts:39 startsWith("..")); Low.
- isPathSafe("C:/x") = false (drive rejected); isPathSafe("/etc/passwd") = TRUE then leading "/" stripped → becomes root-relative "etc/passwd" (safe by design, documented in-code).
- isPathSafe("file.txt:evil") = true (ADS form passes isPathSafe); on Windows NTFS the ":" survives posix.join into the OS call → ADS write/read possible inside root. Security boundary is the root (not reached outside), so severity Low–Medium; flag if root ever contains secrets.
- normalizePath("//") = "." (root); normalizePath("a/../b") = "b". 
- list() on junction to missing target: LIST_FAIL ENOENT (repro of F-01).
- traversal ("a/../../b") = false, null byte = false → good.

## Concurrency / lifecycle notes
- rootRealCache (60s, 200 keys, TtlCache LRU) — symlink root flip within window resolves against stale root (known gap, F-05).
- list stats 32-wide per batch; delete/rename read-then-act (TOCTOU window, doc-acknowledged; Low in single-user local app).
- initialize concurrent runs: mkdir recursive idempotent; workspace.json race can double-write (last-wins, same content) — benign (F-06).
