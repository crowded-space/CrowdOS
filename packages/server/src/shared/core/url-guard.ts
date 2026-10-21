// ponytail: lexical IP/host check. WHATWG host normalization collapses short/hex/octal
// numeric IPv4 forms to dotted quads, so those are caught; the remaining gap is DNS rebinding
// (a public hostname resolving private) — a resolver-level check belongs at the deployment edge.
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

export function isSafeHttpUrl(rawUrl: string, allowPrivate = false): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (allowPrivate) return true;

    // Strip ipv6 brackets and trailing FQDN dots (`localhost.` resolves to loopback).
    const hostname = u.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
    if (!hostname) return false;

    // Reject localhost and loopback names
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      hostname === "::" ||
      hostname === "0.0.0.0"
    ) {
      return false;
    }

    // Check IPv4 matches (127.*, 10.*, 172.16-31.*, 192.168.*, 169.254.*)
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      if (isPrivateIpv4(ipv4Match.slice(1, 5).map(Number))) return false;
    }

    // IPv4-mapped IPv6; WHATWG URL normalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`.
    const mappedDotted = hostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedDotted) {
      if (isPrivateIpv4(mappedDotted[1].split(".").map(Number))) return false;
    } else if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      if (isPrivateIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff])) return false;
    }

    // Check IPv6 loopback / unique local / link local
    if (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
