# shared-auth contracts - partial time-boxed
## requireAuthMounted - auth-gate.ts 127 - global onRequest hook
- OPTIONS passthrough - health exempt - portal discovery exempt
- presented key verified; bad key 401 even from loopback
- keyless loopback trusted as loopback-user; else strict 401
## requireAuth - auth-gate.ts 108 - strict, no loopback
- backs requireAdmin 184 and requireRole 165 viewer-operator-admin ranks
## requirePin - pin-gate.ts 184 - runs before auth hook
- x-pin only 168 - global LOCAL_PIN first, then workspace hash, then any-match
- disabled-allow when unconfigured - management paths allow pinless listing 255
## verifyKey - api-key-service.ts 117
- crowd_ prefix - sha256 hint fast path, legacy full-scan fallback
- dual-boot PG plus local union - revoke in either tier wins
## Low confidence - hook reply.sent interplay not traced end to end
