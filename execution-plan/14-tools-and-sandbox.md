# 14 Tools And Sandbox

## Goal
Let agents act, but only inside safe boundaries.

## Tasks
- [ ] Create tool definition schema.
- [ ] Create central tool registry.
- [ ] Create tool executor.
- [ ] Add per-agent tool authorization.
- [ ] Add filesystem tool set.
- [ ] Add terminal tool set.
- [ ] Add web search tool set.
- [ ] Add database tool set.
- [ ] Add agent management tool set.
- [ ] Add scheduler tool set.

## Safety tasks
- [ ] Add path guard.
- [ ] Add dangerous command blacklist.
- [ ] Add safe command whitelist.
- [ ] Restrict working directory.
- [ ] Restrict supervisor tool access.
- [ ] Add audit logging for tool usage.

## Done when
- Tools can be called through one execution path.
- Unsafe commands are blocked before execution.
