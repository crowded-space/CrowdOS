# Approval decide flow
> Type: Flow · Status: aligned · Updated: 2026-09-13
## Intent
Let the user grant or deny a pending agent action inline, then resume the run without leaving the channel.
## Architectural decision
- [Observed] Decision travels over REST (`POST /api/approvals/:id/decision`) via the store; the socket only carries `approval.requested/decided` state updates.
- [Observed] Decided cards are terminal: they show status instead of action buttons (`ApprovalCard.tsx:69-74`).
## How it works
1. Card shown: pending approval cards render above messages in the active channel, risk-badged with an args preview.
2. User decides: Grant / Deny / Grant-for-session calls `decideApproval` (`ApprovalCard.tsx:84-109`).
3. Persist: store POSTs the decision to `/api/approvals/:id/decision` (`stores/crowdOsStore.ts` via `apiClient`).
4. Card updates: `approval.decided` ingestion flips the card to its terminal status display (`ApprovalCard.tsx:69-74`).
5. Run resumes: the run continues; failed/cancelled turns expose inline Retry via `POST /api/runs/:id/resume`.
  6. Inbox surface: the jobs branch also renders pending approvals as compact `OperationsInbox` rows with the same `decideApproval` path plus Jump (`setActiveChannel`) and Later (`deferLater`, local-only, no server endpoint; deferred rows restore via `undeferInbox`). Approval rows carry an amber icon+text badge; mention rows carry a rose icon+text badge — never color-only.
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Chat Area.md> | Owns `ApprovalCard` rendering and the decide call sites |
| <../Domain Spec/Stores.md> | Owns the derived `inboxItems` projector + `deferLater`/`undeferInbox` (local-only Later) |
| <../Domain Spec/Workspace Shell.md> | Owns `OperationsInbox` rendering in the jobs branch (inbox above jobs) |
## Current state
Card → decide → REST persist → terminal card → run resumes matches the area doc. No `approval:decide` socket emit was observed anywhere in the area docs.
## Alignment notes
- A socket `approval:decide` emit is not the observed path: Chat Area Emits-Listens documents REST `POST /api/approvals/:id/decision` via the store, with the socket receiving `approval.requested/decided`. Spec written to the observed REST path.
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Decision travels over REST POST /api/approvals/:id/decision via the store. Socket carries approval.requested and decided state updates only.
* Decided cards are terminal with status instead of action buttons.
* Grant-for-session scope, expiry, and revocation follow the Approvals domain reusable-grant contract. Unverified client-side scope is forbidden.
* Run-resume handshake after Grant names the event and status that restarts the turn. Retry-endpoint-only tracing is forbidden. Authority: Chat Area area doc; Approvals, Runs domain standards.
## Open gaps
- Grant-for-session semantics (scope, expiry, revocation) unverified in the area docs.
- Run-resume handshake after Grant (which event/status restarts the turn) not traced beyond the retry endpoint.
