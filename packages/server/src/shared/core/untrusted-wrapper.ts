/**
 * CTX-2 untrusted wrapper — wraps untrusted spans in <untrusted source="…">…</untrusted>
 * with proper entity escaping and inner-tag sanitization. Second-order injection
 * defense: the wrapper delimits untrusted content so the model treats it as
 * observed data, not instructions.
 *
 * Flag UNTRUSTED_WRAP=false disables wrapping (legacy rollback).
 */

function isEnabled(): boolean {
  return process.env.UNTRUSTED_WRAP !== "false";
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

function escapeContent(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Wrap an untrusted content span with attribution and escaping.
 * - Escapes &, <, > in content so tags cannot break out.
 * - Escapes source attribute.
 * - Inner tag sanitization is achieved via entity escaping: `</untrusted>`
 *   becomes `&lt;/untrusted&gt;` and cannot close the outer wrapper.
 */
export function wrapUntrusted(source: string, content: string): string {
  if (!isEnabled()) return String(content);
  const safeSource = escapeAttr(source);
  const escaped = escapeContent(content);
  return `<untrusted source="${safeSource}">${escaped}</untrusted>`;
}

export function isUntrustedWrapEnabled(): boolean {
  return isEnabled();
}
