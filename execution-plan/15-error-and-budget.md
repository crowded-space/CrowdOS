# 15 Error And Budget

## Goal
Keep the system stable when agents or models fail.

## Tasks
- [ ] Define error classes and failure reasons.
- [ ] Handle LLM API errors.
- [ ] Handle malformed model output.
- [ ] Handle tool execution failures.
- [ ] Handle self-loop detection.
- [ ] Handle supervisor rejection.
- [ ] Handle context overflow.
- [ ] Handle soft budget cap.
- [ ] Build escalation chain.
- [ ] Pause affected agents cleanly.

## Budget tasks
- [ ] Implement `TokenTracker`.
- [ ] Save token usage logs.
- [ ] Add workspace budget API.
- [ ] Add warning threshold behavior.
- [ ] Add exceeded threshold behavior.
- [ ] Show budget bars and alerts in UI.

## Done when
- Failures stop safely.
- User can see why an agent paused.
- Budget limits can prevent runaway usage.
