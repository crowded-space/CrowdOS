const SENSITIVE_KEYS = new Set([
  "apiKey",
  "api_key",
  "secret",
  "token",
  "authorization",
  "cookie",
  "databaseUrl",
  "database_url",
  "DATABASE_URL",
  "password",
  "credential",
]);

const SENSITIVE_PATTERNS = [/api[_-]?key/i, /secret/i, /token/i, /authorization/i, /password/i];

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

export function maskValue(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (value.length <= 4) return "••••";
  return "••••••••";
}

export function redactSecrets<T>(input: T, seen = new WeakSet()): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return input as T;
  if (typeof input !== "object") return input;
  if (seen.has(input as object)) return input;
  seen.add(input as object);

  if (Array.isArray(input)) {
    return (input as unknown[]).map((v) => redactSecrets(v, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      if (typeof v === "string" && v) {
        out[k] = maskValue(v);
        out[`${k}_configured`] = true;
      } else if (v) {
        out[k] = "••••••••";
        out[`${k}_configured`] = true;
      } else {
        out[k] = v;
        out[`${k}_configured`] = false;
      }
    } else if (v && typeof v === "object") {
      out[k] = redactSecrets(v, seen);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function redactApiKeyFields<T extends Record<string, unknown>>(obj: T): T {
  const clone = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (isSensitiveKey(key)) {
      const val = clone[key] as string | null | undefined;
      clone[key] = val ? maskValue(val) : val;
      clone[`${key}_configured`] = !!val;
      if (key === "apiKey" || key === "api_key") {
        clone["apiKeyMasked"] = clone[key];
        clone["configured"] = !!val;
      }
    }
  }
  return clone as T;
}

export function stripSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...headers };
  for (const k of Object.keys(redacted)) {
    if (isSensitiveKey(k)) redacted[k] = "[REDACTED]";
  }
  return redacted;
}

export function redactLogPayload(payload: unknown): unknown {
  try {
    return redactSecrets(payload);
  } catch {
    return "[REDACTED]";
  }
}
