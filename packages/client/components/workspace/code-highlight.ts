import hljs from 'highlight.js/lib/common';

const MAX_HIGHLIGHT_CHARS = 100_000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function languageFromHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const normalized = hint.trim().toLowerCase();
  if (!normalized) return null;
  return hljs.getLanguage(normalized) ? normalized : null;
}

export function languageFromPath(path: string): string | null {
  const ext = path.split('.').pop();
  if (!ext || ext === path) return null;
  return languageFromHint(ext);
}

export function highlightCode(code: string, hint?: string | null): string {
  if (code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);
  const language = languageFromHint(hint);
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
