import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { getThemePref, resolveTheme, setThemePref, cycleTheme } from '@/src/config/theme';
import type { themePref } from '@/src/config/theme';

const labels: Record<themePref, string> = {
  auto: 'System',
  light: 'Light',
  dark: 'Dark',
};

export default function ThemeToggle() {
  const [pref, setPref] = useState<themePref>('dark');
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const sync = () => {
      const p = getThemePref();
      setPref(p);
      setResolved(resolveTheme(p));
    };
    sync();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const Icon = pref === 'auto' ? Monitor : resolved === 'light' ? Sun : Moon;
  const next = cycleTheme(pref);

  const handleClick = () => {
    const n = cycleTheme(getThemePref());
    setPref(n);
    setResolved(setThemePref(n));
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Theme ${labels[pref]}. Switch to ${labels[next]}.`}
      title={`Theme ${labels[pref]}. Click for ${labels[next]}.`}
      className="w-11 h-11 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center shrink-0 active:scale-95"
    >
      <Icon size={18} className="shrink-0" aria-hidden="true" />
    </button>
  );
}
