# Queue Domain — Plan (audit phases 1–4 only; NO production edits made)
Time-boxed read-only audit. All findings are advisory; nothing below was executed.

## Rewrite decision
REJECT full rewrite. RECOMMEND incremental fixes. Rationale: gate contract is correct and thin; single-owner topology (worker owns repeatables; API suppresses local timers) is deliberate and documented; baseline tsc=0, tests=19/19, gates=0 violations. The defects are localized (Q-1 heartbeat no-op, Q-2/Q-5 resume honesty, Q-3 job identity, Q-6 DLQ visibility) and can be fixed file-by-file without touching the facade shape. A rewrite would forfeit the doc-verified invariants (idempotent enqueue, inline no-op, drain) and the frozen naming baseline.

## Ordered fix plan (each step: code + doc + test in the SAME task per AGENTS §6)
1. Q-1 (S1) Fix heartbeats-touch: export touchWorkingAgents (or add worker-side lease path); wire maintenance handler to the real symbol; add regression test that calls maintenanceProcessor("heartbeats-touch") and asserts agentGate.touchHeartbeat invoked. Docs: Queue.md Flow step 6 + Feature doc.
2. Q-2/Q-5 (S2) Resume honesty: surface enqueue failure in routes/runs.ts + socket resume (status/flag or non-2xx); distinguish duplicate vs created (new result field). Type resumeContext/resumeFrom into EnqueueRunInput; drop @ts-ignore. Tests: route-level enqueue-failure test; duplicate-status test. Docs: Failure + Resume section.
3. Q-3 (S2) Job identity: move to run:<runId>:attempt:<n> (operator decision Q1 in doc) keeping channel:agent:message as secondary hint; update resume messageId scheme; tests for re-attempt after completion. Docs: Architectural Standard update.
4. Q-6 (S3) DLQ visibility: add gate port (or selector) for maintenance/scheduler failed jobs; extend /api/queue/failed. Test with fake failed jobs. Docs: Ports + Gaps.
5. Q-4/Q-7 (S3) Scheduler hardening: exact name allowlist; unique delayed jobId namespacing; tests. Docs: scheduler flow notes.
6. Q-8 (S2/S3) Snapshot override fidelity: read real columns or drop section until a port exists. Test shape mapping.
7. Q-9 (S3) Encapsulate scheduler queue access behind named ports (scheduleCron/scheduleDelayed/removeSchedule); migrate tool-registry.ts; gate contract test.
8. Q-10 (S3) Research trace: decide intent (trace vs dispatch); remove enqueue if trace-only. Doc: open gap resolution.
9. Q-11/Q-12/Q-13/Q-14 (S3) Hygiene: delete dead exports or mark test-only; direct imports over string-keyed dynamic access; healthCheck maintenance counts; duplicate-detection robustness.
10. Docs sync pass: re-verify doc line citations (a few stale, e.g. queues.ts:129–135 vs actual 130–134); update audit/ notes only — production docs updated in the tasks above, not now.

## Constraints honored
- No production edits; no branch; no commit; main untouched; git delta = audit/ only.
- Docs noted, not modified (re-docs Queue.md + Queue delivery and housekeeping.md already describe most gaps; they must be updated when fixes land).
