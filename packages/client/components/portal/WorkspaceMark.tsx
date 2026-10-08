import React from 'react';

/**
 * Muted workspace mark: one crow silhouette on a quiet desaturated tile.
 * Stored icon ids stay unchanged; only the rendering is restrained.
 * No gradients, glows, or animation. Selection is a 1px ring.
 */

const CROW_PATH =
  'M58 20 C54 18 48 19 43 23 C38 27 35 32 31 35 C28 38 22 36 17 35 C24 38 28 41 31 43 C32 48 34 54 37 59 C40 65 46 72 54 75 C58 77 62 78 66 79 C63 82 59 86 54 88 C49 90 42 92 37 94 C43 94 53 92 59 89 C64 87 67 85 71 81 C73 84 76 86 79 88 C74 90 69 91 64 92 C71 92 78 91 82 88 C85 86 88 83 91 80 L92 78 C93 80 94 83 96 85 C92 87 87 88 81 89 C85 89 91 88 95 85 C98 83 100 80 101 77 C103 70 104 61 102 51 C100 40 95 30 88 22 C81 14 74 12 66 12 C62 12 59 15 58 20 Z';

export const MARK_TONES: Record<string, { tile: string; ink: string; label: string }> = {
  'crow-white-rounded': { tile: '#1c1c1f', ink: '#e4e4e7', label: 'Bone' },
  'crow-dark-rounded': { tile: '#e4e4e7', ink: '#27272a', label: 'Graphite' },
  'crow-indigo-circle': { tile: '#2b3350', ink: '#c3cdf5', label: 'Slate blue' },
  'crow-amber-cyber': { tile: '#3a3325', ink: '#d9c193', label: 'Ochre' },
  'crow-cyan-radar': { tile: '#24373a', ink: '#b8cdd0', label: 'Steel' },
  'crow-rose-governance': { tile: '#3d2b2e', ink: '#d8b6ba', label: 'Oxide red' },
  'crow-matrix-terminal': { tile: '#26352d', ink: '#b3c9b8', label: 'Moss' },
  'crow-cosmos': { tile: '#322b44', ink: '#c2b8d4', label: 'Plum' },
};

const ORDER = [
  'crow-white-rounded',
  'crow-dark-rounded',
  'crow-indigo-circle',
  'crow-amber-cyber',
  'crow-cyan-radar',
  'crow-rose-governance',
  'crow-matrix-terminal',
  'crow-cosmos',
];

export function markToneFor(variant: string): { tile: string; ink: string; label: string } {
  if (variant && MARK_TONES[variant]) return MARK_TONES[variant];
  let hash = 0;
  for (let i = 0; i < variant.length; i++) hash = (hash * 31 + variant.charCodeAt(i)) | 0;
  return MARK_TONES[ORDER[Math.abs(hash) % ORDER.length]];
}

export default function WorkspaceMark({
  variant,
  size = 32,
  selected = false,
  label,
}: {
  variant: string;
  size?: 24 | 28 | 32 | 40;
  selected?: boolean;
  label?: string;
}) {
  const tone = markToneFor(variant);
  return (
    <span
      role="img"
      aria-label={label ?? 'Workspace mark ' + tone.label}
      style={{
        width: size,
        height: size,
        background: tone.tile,
        color: tone.ink,
        border: selected ? '1px solid #465EDB' : '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg viewBox="0 0 120 120" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} fill="none" aria-hidden="true">
        <path d={CROW_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}
