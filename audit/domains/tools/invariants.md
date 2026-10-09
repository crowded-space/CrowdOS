# Tools Domain — Invariants (Phase 3)

Status: Holds / Violated / Untested / Drift. Evidence file:line.

1. execute never throws for tool-level problems — Holds (executor.ts:816-826; stateless refusal returns ToolResult, :311-317).
2. Authorization order fixed: agent → skill allowlist (+5 fallbacks) → def → authLevel → Guard — Holds (executor.ts:347-374, fallback list :358).
3. authLevel fail-closed default (?? 0) in executor and list() — Holds (executor.ts:372; registry.ts:219-221).
4. `authorityLevel > required && !isOmniscient` blocks higher-numbered (less privileged) agents; L0 passes everything — Holds by design (docs + read-workspace-local.test.ts:7-11).
5. Batch results in request order; pre-write reads parallel, post-write reads serial — Holds (executor.ts:261-288; pinned tool-executor.batch.test.ts).
6. Unknown tool effect class defaults to 'write' — Holds (executor.ts:40-43).
7. Approval waits always terminate (broker fast path + 1s→5s poll + TTL+2.5s ceiling) — Holds (executor.ts:154-199); broker-unsubscribe cleanup correctness Untested (TOLS-09); ceiling timer not cleared but guarded by settled (TOLS-10).
8. Approval deny/expiry resumes run to running and fails only the tool — Holds (executor.ts:543-552, 731-735).
9. Reusable grants never skip audit when runId exists; bash requires runId, FS allows no-runId execution — Drift (asymmetry) (executor.ts:400-404 vs 647-676).
10. Full-args scope hash (no 500-char prefix collisions) — Holds (executor.ts:410, 641).
11. Timeout aborts underlying work via combined signal — Partial/Violated for FS handlers: write/edit/delete never observe abortSignal, so a timed-out mutation can still complete after failure is reported — Violated (TOLS-02; registry.ts:278-433 vs executor.ts:792-807).
12. execute_bash effective timeout = 300s — Drift/Violated: toolDef has no timeoutMs → executor default 30s; handler's 300s is unreachable — Violated (TOLS-01; registry.ts:436-464; executor.ts:755).
13. MCP server claims can only escalate danger — Holds (mcp-client-manager.ts:60-67; pinned mcp test :53-79).
14. MCP crash/cleanup unregisters tools + rejects pending — Holds (mcp-client-manager.ts:236-248, 290-302, 417-424; test :81-105).
15. MCP circuit breaker disables a failing server after 5 consecutive failures — Violated: status set to 'error' but process kept alive, tools stay registered, handlers still sendJsonRpc (breaker is advisory) — Violated (TOLS-03; mcp-client-manager.ts:426-432, 448-475).
16. MCP sessions/configs durable or explicitly ephemeral — Violated: mcp_servers table has no runtime writer/reader; restart loses all servers — Violated (TOLS-05; schema.ts:875; manager memory-only :154).
17. connect/disconnect serialized (no reconnect race) — Violated (window): disconnect during in-flight connect leaves status 'error' or dead tools registered — Untested/Violated (TOLS-06).
18. Query_database layered read-only (verb+word+func+single-stmt+allowlist+LIMIT 100+5s timeout) — Holds (registry.ts:551-617; pinned honest.test.ts:121-243).
19. Scheduler honesty: real persist+emit, no silent 60s fallback; invalid cron rejects — Holds (registry.ts:666-718; honest/bullmq tests).
20. Inline cron semantics equal expression semantics — Violated (edge): */N minutes clamped at 2^31-1ms (~24.8d) fires early (TOLS-14; registry.ts:709).
21. activeSchedules tracks live schedules and releases them — Violated: BullMQ one-shot entries never deleted; inline cron entries only removable via cancelSchedule, which has zero callers and is not gate-exported (TOLS-04; registry.ts:81,182,751).
22. Zone A reachable only via read_workspace_local (L0, read-only) — Holds (registry.ts:1323-1401; pinned read-workspace-local.test.ts).
23. open_detail discloses shape, never grants access; executor re-authorizes every call — Holds (registry.ts:1101-1237; open-detail-expansion.test.ts).
24. Stateless workers cannot write private memory (executor-level) — Holds (executor.ts:311-317; stateless-worker.test.ts).
25. Universal tool lists agree across domains — Drift: executor hardcodes 5 (executor.ts:358) vs skill-service UNIVERSAL_TOOLS 7 incl. lock_in/lock_out (skill-service.ts:262-270) (TOLS-08).
26. Authz evaluated against the same DB as identity — Violated (risk): agent row from workspace DB, skills allowlist from ambient DB (TOLS-07; executor.ts:336-356).
27. Facade contract preserved: external imports only via tools-gate.ts — Holds for production code (check-gates.mjs 0 violations); test-only bypasses known (approvals/channel-mounts tests).
28. Gate shape == docs Ports — Holds (Tools.md:61-74 matches tools-gate.ts).
