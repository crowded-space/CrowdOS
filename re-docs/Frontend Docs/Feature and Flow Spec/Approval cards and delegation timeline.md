# Approval cards and delegation timeline

> Type: Feature · Status: aligned · Updated: 2026-09-13

## Intent

Let the operator grant or deny a risky tool run inline without losing stream context, and see who handed what to whom (from → to, task, spend) as the swarm delegates.

## Architectural decision

- [Observed] Pending approvals render above messages as blocking-style cards with risk badge, tool name, run fragment, args preview, and three actions: Grant, Deny, Grant-for-session (`ApprovalCard.tsx:46-109`).
- [Observed] Decided cards stay in place as terminal status (`APPROVED`/`DENIED`) rather than disappearing (`ApprovalCard.tsx:69-74,110-114`).
- [Observed] Delegation renders as one dispatch card per event (from → to buttons, task directive, tokens/cost, status pill), ordered by the stream — there is no separate chained-timeline view (`DelegationMessage.tsx:24-82`).
- [Inferred] Session grants trade strict per-run consent for flow; the `title` ("remember for this tool+args for session") is the only scope definition observed.

## How it works

`ApprovalCard` truncates the args preview to 300 chars (`truncateJson`, `ApprovalCard.tsx:5-14`), badges risk class (install/network/destructive/git_push/db_write/general, `ApprovalCard.tsx:16-26`), and calls `decideApproval(id, decision, scope?)` with per-button busy state; Grant-for-session passes scope `'reusable'` (`ApprovalCard.tsx:34-44,83-109`). Expiry shows as a clock time or `pending` (`ApprovalCard.tsx:59-62`); enforcement behavior unverified. `DelegationMessage` links both agent names to their profile modals (`openAgentProfileModal`, `DelegationMessage.tsx:41-58`), shows the task directive verbatim, and budgets as tokens + `$gas` with a pending/executing/completed/failed pill (`DelegationMessage.tsx:60-81`).

## Components involved

| Area doc | Role |
|---|---|
| <../Domain Spec/Chat Area.md> | Owns approval injection above messages, the `ApprovalCard`/`DelegationMessage` renderers, and the store/socket decision flow; this spec narrates only the card UX and delegation display |

## Current state

Pending cards show all three 36px-min actions with disabled-while-deciding; decided cards show terminal status text. Delegation cards show from → to, task, token/cost, and status as described. Matches the area doc's approval and delegation expectations.

## Alignment notes

none found

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Pending approvals render above messages as blocking-style cards with risk badge, tool name, run fragment, args preview, and Grant, Deny, Grant-for-session. Decided cards stay as terminal status, never disappearing.
* Session grants have an explicit scope contract: exact tool-plus-args versus tool-only, with expiry and revocation. Button-title-only scope is forbidden.
* Approval expiry enforcement plus decided-card retention lifetime are explicit. Silent undecided-expiry is forbidden.
* Delegation renders one dispatch card per event with from-to, task, tokens and cost, status pill. Multi-hop chains link and fold by run or are explicitly stream-only by contract.
* Delegation failure has an explicit retry and reassign path. Token and cost sources are documented. Authority: Chat Area area doc; Approvals domain standard for grant semantics.
## Open gaps

- Approval expiry enforcement and decided-card retention lifetime unverified.
- Session-grant matching semantics (exact tool+args vs tool-only) unverified beyond the button title; server authority unverified.
- No multi-hop chain visualization: related delegations are only adjacent cards in stream order, with no link/fold by run.
- Delegation failure path (retry, reassign) and token/cost source accuracy unverified.
