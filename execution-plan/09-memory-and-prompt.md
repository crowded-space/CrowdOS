# 09 Memory And Prompt

## Goal
Build the prompt pipeline for agent execution.

## Tasks
- [ ] Define shared message format.
- [ ] Define mention metadata format.
- [ ] Define memory visibility rules by level.
- [ ] Implement `MemoryBuilder`.
- [ ] Add XML-like prompt sections.
- [ ] Add pinned context tier.
- [ ] Add recent context tier.
- [ ] Add compressed summary tier.
- [ ] Add token counting hook.
- [ ] Add prompt templates for L1, L2, L3 worker, L3 supervisor.

## Small checks
- [ ] L1 can see allowed channel context.
- [ ] L3 worker sees only task-specific context.
- [ ] Prompt output is deterministic for same input.

## Done when
- Prompt assembly is reusable and testable.
- Each authority level gets the right context only.
