// Phase E: secret-pattern redaction vocabulary (display-only). splitSecrets
// marks spans for RedactedText (shown-as-redacted + click-reveal); the raw
// value is never logged — it only renders behind an explicit reveal toggle,
// and the existing copy buttons keep their behaviour (explicit user action).

export type secretPart = {
  text: string;
  redacted: boolean;
};

const SECRET_SOURCE = [
  'sk-[A-Za-z0-9_-]{16,}',
  '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}',
  'xox[baprs]-[A-Za-z0-9_-]{10,}',
  'AKIA[0-9A-Z]{16}',
  '-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY)-----',
  'Bearer\\s+[A-Za-z0-9\\-._~+/=]{10,}',
  '(?:api[_-]?key|secret|password|passwd|pwd|access[_-]?token|auth[_-]?token)\\s*[:=]\\s*[^\\s\'";,]{4,}',
].join('|');

function secretPattern(): RegExp {
  return new RegExp(SECRET_SOURCE, 'gi');
}

export function countSecrets(text: string): number {
  if (!text) return 0;
  const found = text.match(secretPattern());
  return found ? found.length : 0;
}

export function redactText(text: string): string {
  if (!text) return text;
  return text.replace(secretPattern(), '[redacted]');
}

export function splitSecrets(text: string): secretPart[] {
  if (!text) return [{ text, redacted: false }];
  const re = secretPattern();
  const out: secretPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), redacted: false });
    out.push({ text: m[0], redacted: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push({ text: text.slice(last), redacted: false });
  return out.length > 0 ? out : [{ text, redacted: false }];
}
