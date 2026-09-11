// ponytail: lexical IP/host check, DNS-rebind resolver check when exposed publicly
export function isSafeHttpUrl(rawUrl: string, allowPrivate = false): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (allowPrivate) return true;

    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip ipv6 brackets
    if (!hostname) return false;

    // Reject localhost and loopback names
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0.0.0.0") {
      return false;
    }

    // Check IPv4 matches (127.*, 10.*, 172.16-31.*, 192.168.*, 169.254.*)
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [_, a, b] = ipv4Match.map(Number);
      if (a === 127) return false;
      if (a === 10) return false;
      if (a === 169 && b === 254) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 0) return false;
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
