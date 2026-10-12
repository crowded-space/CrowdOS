# Provider adapters and streaming
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Five model providers must look like one interface to the runtimes, so swapping models never changes execution code — and token streams must reach clients cheaply without one socket event per token.

## Architectural decision
A `ProviderRegistry` maps provider name → adapter, and `callLLM` resolves the adapter from `packet.metadata.provider` per call; a missing adapter throws inside the call and fails the run, never the process [Observed]. Streaming chunks are coalesced per batch window (`STREAM_BATCH_MS`, default 50; `0` restores per-token emission) and flushed on LLM completion [Observed]. Retries are pre-stream-only (2×, 1s/2s backoff on connect/network failures before the first chunk); mid-stream failures and caller aborts never retry, avoiding duplicate side effects [Observed]. Provider HTTP layers enforce connect/idle timeouts around every fetch [Observed].

## How it works
`initRuntime` registers the five adapters (google, anthropic, openai, ollama, custom — the last OpenAI-compatible) at boot; `runtimeGate.registerProvider`/`getProvider`/`hasProvider` expose the registry. `RuntimeKernel.callLLM` resolves the adapter, and when the packet allows streaming and a broker is present it streams chunks through the coalescer as `message:stream` events, accumulates content/thoughts buffers, falls back to the `ReActStreamParser` when the provider returned no native tool calls, and records `llm.call` timings. `BaseRuntime` wraps the call with the pre-stream retry (abort-aware, provider-error-aware) and maps caller aborts to `cancelled` with zeroed usage. Cancellation propagates via the packet's `abortSignal` into loop checkpoints, provider fetches, and run-close.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Runtime.md> | Owns the registry, the five adapters, the `callLLM` + coalescer kernel path, and pre-stream retry/timeout guards |
| <../Domain Spec/Context.md> | Resolves and decrypts the model config the adapters consume (single choke point) |

## Current state
Real: registry with throw-on-missing, all five adapters, stream coalescing with flush-on-completion, ReAct fallback, pre-stream-only retry, connect/idle timeouts, abort-to-cancelled mapping. Flag-gated: coalesce window (`STREAM_BATCH_MS`). Stub: none.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Five adapters google, anthropic, openai, ollama, custom stay with streaming coalescer, pre-stream retry, timeout guards.
* Pre-stream connect failures retry twice with backoff. Post-stream failures and caller aborts never retry.
* Missing provider throws inside callLLM with failed-result plus failed close. Silent fallback is forbidden. Authority: Runtime standard.
## Open gaps
- Env-key fallback covers only google/anthropic/openai rows; ollama/custom rely solely on stored keys — whether intentional is unverified.
- `tool-provider-adapter.ts` role in the adapter set (bridge vs sixth adapter) was not traced.
- Adapter-level capability flags (`supportsStreaming`/`supportsTools`) per provider were not enumerated — non-streaming fallback coverage unverified.
