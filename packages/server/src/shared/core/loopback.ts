// ─── Loopback peer predicate (single source of truth) ────────────
// CrowdOS §19 is a single-user local-app threat model, so "same machine" is
// the trust boundary for keyless access. REST (shared/auth/auth-gate.ts) and
// sockets (shared/sockets/socket-auth.ts) MUST agree on it exactly — if the two
// boundaries drift, one transport becomes a way around the other.
//
// Lives in Shared (gate-exempt per the Domain Facade Standard) so neither
// transport has to import the other: socket-auth already imports auth-gate, so
// auth-gate importing socket-auth would be a cycle.

/**
 * True for same-machine peers: IPv4/IPv6 loopback, including the IPv4-mapped
 * form Node reports for a loopback client on a dual-stack socket.
 */
export function isLoopbackPeer(address: string | undefined | null): boolean {
  if (!address) return false;
  const host = address.trim().toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

