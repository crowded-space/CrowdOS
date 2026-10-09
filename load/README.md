# Load Suite — SCL-1

Validated targets: **100 concurrent sends · 10 concurrent swarms · 8h soak**

## Suites

| Suite | Tool | Entry | Concurrency | Duration | Thresholds |
|-------|------|-------|-------------|----------|------------|
| concurrent-sends | k6 | `load/k6/concurrent-sends.js` | 100 VUs ramp | 2m20s | p95 <800ms, error <1% |
| concurrent-swarms | k6 | `load/k6/concurrent-swarms.js` | 10 VUs | 2m | p95 <1200ms, error <2% |
| soak | k6 | `load/k6/soak.js` | 20 VUs | `SOAK_DURATION` (2m smoke / 8h nightly) | p95 <1000ms, no starvation |
| artillery alt | artillery | `load/artillery/*.yml` | same | — | same |

## Running

```bash
# smoke (no infra needed beyond API)
k6 run load/k6/concurrent-sends.js
k6 run load/k6/concurrent-swarms.js
k6 run load/k6/soak.js

# 8h nightly (CI nightly workflow)
SOAK_DURATION=8h k6 run load/k6/soak.js

# artillery alternative
npx artillery run load/artillery/concurrent-sends.yml
```

Or via npm:

```bash
npm run load:concurrent-sends   # k6 100 VUs
npm run load:concurrent-swarms  # k6 10 swarms
npm run load:soak               # k6 soak (2m)
npm run load:soak:nightly       # k6 soak 8h
```

## Node harness (no k6 binary)

`packages/server/src/Queue/queueGate.ts` healthCheck is polled by the Node harness
`load/harness.mjs` to assert no queue starvation / vault bounded without k6:

```bash
node load/harness.mjs --base http://localhost:12077 --vus 100 --duration 60
```

## What is asserted

- **error budgets held**: http_req_failed < 1% (sends), <2% (swarms)
- **no queue starvation**: `queueGate.healthCheck.waiting` never exceeds 1000 sustained; BullMQ `getJobCounts` stable
- **vault bounded**: `agent_memory_notes` per-agent cap 500 enforced via `enforceNoteCap` even under 100 concurrent sends (query-count-per-send flat via regression test with 5k-message channel)
- **soak 8h**: soak script is duration-parameterized; nightly CI runs it with `SOAK_DURATION=8h` and asserts p95 stability before/after

## CI

- `ci.yml` runs smoke on PR (2m soak)
- nightly workflow runs 8h soak against staging (optional, requires `BASE_URL` secret)
