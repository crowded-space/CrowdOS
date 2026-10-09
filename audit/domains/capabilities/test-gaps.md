# Capabilities — Test Gaps

Covered well: availability filter, authority mirror (incl. fail-closed ?? 0, omniscient), expansion scoping, manifest overlay basics, merge purity, sanitization, catalog integrity vs live registry, deferral reachability, open_detail wiring.

| # | Gap | Risk |
|---|---|---|
| T1 | No two-workspace manifest differentiation test (only "unscoped sees nothing") | §30 claim "two workspaces expose different vocabularies" unpinned |
| T2 | No expand() + workspaceId test where manifest disabled the id | hidden-vs-nonexistent contract partially unpinned |
| T3 | resolveAuthority catch path (agentGate.getById THROWS) untested — only null return | fail-closed behavior on transient lookup failure unpinned |
| T4 | Manifest override fallbacks untested: non-array tools, empty tools[], duplicate ids, whitespace ids | silent-fallback behavior unverified (CAP-008) |
| T5 | No assertion mergeManifest output is deep-copied (mutating result must not affect input/catalog) | mutation-leak regression risk |
| T6 | No gate-surface drift test (exact export list = docs Ports) | accidental port addition/removal invisible |
| T7 | No test that get() is intentionally unfiltered (or that no production caller uses it) | CAP-004 misuse risk |
| T8 | expand() with empty/whitespace capabilityId untested | minor |
| T9 | Catalog/descriptor immutability untested (Object.freeze shallow — CAP-002) | mutation regression risk |
| T10 | available:true only key-presence asserted; no semantic assertion | field could silently flip meaning |

