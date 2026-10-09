# shared-auth invariants - partial time-boxed
- INV-1 identity server-side only: from verified key or loopback peer, never client headers - auth-gate.ts 99 144, socket-auth.ts 58
- INV-2 presented bad key fails even on loopback - auth-gate.ts 149
- INV-3 loopback predicate single source shared/core/loopback.ts, re-exported by both gates
- INV-4 PIN on x-pin only, never Authorization - pin-gate.ts 168, auth-pin-header.test.ts
- INV-5 screenlock opt-in: unconfigured means allow, no default PIN - pin-gate.ts 191 215
- INV-6 plaintext never persisted: scrypt hashes only, timingSafeEqual compare
- INV-7 revoke in either tier wins - api-key-service.ts 81 203
- INV-8 portal boundary shared via isWorkspaceManagementPath pin-gate.ts 155, narrowed by method in auth-gate.ts 47
- Low confidence: hook ordering vs tenant 503 interplay not fully traced
