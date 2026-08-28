# 17 Testing And Release

## Goal
Verify the system in layers as features land.

## Unit tests
- [ ] Setup Vitest in server.
- [ ] Setup Vitest in client.
- [ ] Test `EventBroker`.
- [ ] Test `MemoryBuilder`.
- [ ] Test `AgentRegistry`.
- [ ] Test `ChannelController`.
- [ ] Test `LoopArbiter`.
- [ ] Test `AgentSpawnManager`.
- [ ] Test mention parsing.
- [ ] Test `TokenTracker`.

## Integration tests
- [ ] Add mock model adapter.
- [ ] Test user message -> L1 response flow.
- [ ] Test L1 -> L2 dispatch flow.
- [ ] Test L2 -> L3 spawn flow.
- [ ] Test mention trigger flow.
- [ ] Test escalation flow.
- [ ] Test budget enforcement flow.
- [ ] Setup PostgreSQL test environment.

## E2E tests
- [ ] Setup Playwright.
- [ ] Test agent creation flow.
- [ ] Test chat flow.
- [ ] Test dispatch flow.
- [ ] Test mention flow.
- [ ] Test settings flow.
- [ ] Test error flow.

## Release readiness
- [ ] Add lint and typecheck to CI.
- [ ] Add test commands to CI.
- [ ] Add manual smoke test checklist.
- [ ] Add milestone review after each major phase.

## Done when
- Core modules have automated coverage.
- Happy path user flows work in browser.
- The project can be iterated without breaking core behavior.
