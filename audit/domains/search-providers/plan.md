# search-providers — Fix Plan (incremental; prefer incremental over rewrite)

Decision: **incremental**. Domain is ~620 LOC source, thin gate, zero boundary violations, 26 green tests.
A rewrite has no payoff; fix the three real items below.

## Ordered plan
1. **SP-01 (S2, do first)** — `search-provider-service.ts:104`: skip near-dup when `tok.size === 0`
   (mirror timestamp policy: no signal ≠ duplicate). Add regression test (G1). Keep gate contract unchanged.
2. **SP-02 (S3)** — narrow `SearchResult.source` to `'brave' | 'tavily' | 'serper'` in types; mappers already compliant.
   Verify no caller writes free-form sources (research-runtime builds bundle from these rows only).
3. **SP-08 (S3)** — merge `timestamp` from a dropped duplicate onto the kept row inside `dedupeByUrl`.
4. **SP-07 (S3)** — `Number.isFinite(timeoutMs)` guard in the three providers.
5. **SP-06 (S3)** — type `ProviderEntry` as `SearchProvider`.
6. **SP-04 (S3, coordinated)** — design optional failure signal with Research/Tools owners; do not change return type unilaterally.
7. **SP-03 (S3)** — 429 backoff only if throttling observed (leave as-is unless evidence).
8. **Docs sync (SP-05)** — same task as any code change: fix `SearchProviders.md` + `Web search fan-out.md` line refs,
   add `Domain Spec/_index.md`; update Ports only if gate shape changes.

## Guardrails
- Do not rename files/exports (frozen camelCase + gate contract).
- Keep `__testMap*Json` internal; do not promote to gate.
- Re-run after each change: `npx tsc -p tsconfig.json --noEmit`, `npx vitest run src/search-providers`,
  `node scripts/check-gates.mjs` (from `packages/server`).
- No commit/branch per AGENTS.md; commit only on explicit user yes via `git-crow`.
