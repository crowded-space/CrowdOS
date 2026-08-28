# 10 L1 Router And Dispatch

## Goal
Make the first intelligent orchestration path.

## Tasks
- [ ] Create base agent runtime classes.
- [ ] Implement L1 agent runtime.
- [ ] Add simple path: L1 answers user directly.
- [ ] Implement `read_agent_registry` tool.
- [ ] Implement `create_workspace` tool.
- [ ] Implement `bipolar_dispatch` tool schema.
- [ ] Build subtask decomposition flow.
- [ ] Build L2 matching flow from agent registry.
- [ ] Add fallback when no L2 matches.
- [ ] Add multi-L2 dispatch support.

## Small checks
- [ ] Simple request stays in L1.
- [ ] Complex request creates dispatch plan.
- [ ] User gets a readable dispatch summary.

## Done when
- One user message can either get a direct answer or a routed plan.
