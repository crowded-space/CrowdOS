# Changelog

## Revised workflow skill — 2026-10-03

### Added
- Explicit control-plane vs execution-plane separation.
- Task classification for atomic, parallel, sequential, verification, and integration work.
- Dependency/DAG guidance and task lifecycle states.
- A complete delegation-contract standard with explicit scope and non-goals.
- Context-protection rules and a compact handoff record.
- Proportional, evidence-based verification with independent reviewers when needed.
- Failure taxonomy, targeted retry guidance, partial-completion handling, and retry-loop limits.
- Security, privacy, provenance, and untrusted-input guardrails.
- Canonical sub-agent output contract for consistent downstream integration.
- Main-agent preflight and completion gates.
- Explicit integration decision rules.

### Changed
- Clarified that the main agent may perform mechanical control checks but not substantive delegated execution.
- Replaced the previous broad “stop for any inefficiency” escalation with a targeted Exception Gate for genuine hierarchy conflicts.
- Expanded the instruction template from six core sections to nine operational sections while preserving the original skeleton's purpose.
- Added concrete verification requirements and prohibited unverified `PASSED` claims.

### Included
- `references/sub-agent-instruction-template.md` — updated canonical delegation template.
- `docs/hierarchical-workflow-changes.pptx` — presentation explaining the revision.
