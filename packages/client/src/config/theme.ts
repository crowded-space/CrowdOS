// Theme preference: auto (system) by default, manual override persisted.
// The resolved theme drives documentElement data-theme + colorScheme, which
// the [data-theme="light"] override layer in index.css reads. Dark is the
// untouched default: no data-theme attr styling needed for dark.

export type themePref = 'auto' | 'light' | 'dark';

const KEY = 'crowdos_theme';

export function getThemePref(): themePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    // private-mode safe: fall through to auto
  }
  return 'auto';
}

export function resolveTheme(pref: themePref): 'light' | 'dark' {
  if (pref !== 'auto') return pref;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function applyTheme(pref: themePref): 'light' | 'dark' {
  const resolved = resolveTheme(pref);
  try {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    // never break boot on DOM access
  }
  return resolved;
}

export function setThemePref(pref: themePref): 'light' | 'dark' {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // private-mode safe: theme still applies for the session
  }
  return applyTheme(pref);
}

// ponytail: single init at boot; per-component listeners live in ThemeToggle.
export function initTheme(): () => void {
  applyTheme(getThemePref());
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (getThemePref() === 'auto') applyTheme('auto');
  };
  mq.addEventListener('change', onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) applyTheme(getThemePref());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    mq.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function cycleTheme(pref: themePref): themePref {
  if (pref === 'auto') return 'light';
  if (pref === 'light') return 'dark';
  return 'auto';
}
