# Swarm Domain - Plan (incremental; no rewrite)

## Rewrite decision: INCREMENTAL
Facade is thin (10 ports, no logic), boundary is clean (gate-to-gate only; check-gates 0 production violations), execution is honest (no fabricated success), and the suite is green. Defects cluster in persistence coherence, honesty strings, and type/doc drift - all localized. A rewrite would re-risk a working contract for no structural gain.

## Ordered fixes (docs sync in the same task per AGENTS.md 6; main only; stop for review before commit)
1. SW-02 schema drift (schema.ts:552) - smallest, highest prod impact; run drizzle generate and confirm no diff.
2. SW-01 transition guard: PG read or CAS before update; add a PG-mode repository test.
3. SW-03 truncation honesty: fix the message or the stored-content contract.
4. SW-04 abort ordering: check before delete/create or settle rows on cancel.
5. SW-05 blocked status in the result map (or document the map contract) + Domain Spec Gaps update.
6. SW-06/SW-07 delete/create robustness: verify delete, upsert create.
7. SW-20 + SW-09: add workspaceId to delegation payload types; router uses the gate flag reader.
8. SW-08 Q1 operator decision (strict prerequisite vs audited exception).
9. SW-10, SW-11, SW-12, SW-15, SW-16, SW-18, SW-19 - low-severity cleanup.
10. SW-13/SW-14 docs notes; local file tier remains a known domain gap.

## Constraints
- No production edits in this audit; no branch; no commit until explicit user approval.
- Planned fixes do not change the gate shape (Ports/Relations stable) - update Domain Spec Gaps + Feature/Flow docs only.
- Gate contract must be preserved: exactly the 10 current ports.
