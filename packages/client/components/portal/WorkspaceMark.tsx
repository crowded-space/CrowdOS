import React from 'react';
import { CrowSigil } from '@/components/ui/CrowSigil';

/**
 * Workspace mark: crisp Crow Sigil SVG on a restrained architectural tile.
 * Stored icon ids stay unchanged; rendering uses dark/light color inversion
 * for the primary obsidian/chalk marks and muted desaturated tiles for the rest.
 */

export const MARK_TONES: Record<
  string,
  { tile: string; ink: string; detail: string; label: string; isCircle?: boolean }
> = {
  'crow-white-rounded': {
    tile: '#141418',
    ink: '#FAFAFA',
    detail: '#141418',
    label: 'Obsidian',
  },
  'crow-dark-rounded': {
    tile: '#F4F4F5',
    ink: '#0B0B0E',
    detail: '#F4F4F5',
    label: 'Chalk',
  },
  'crow-indigo-circle': {
    tile: '#4B55FF',
    ink: '#FFFFFF',
    detail: '#4B55FF',
    label: 'Cobalt',
    isCircle: true,
  },
  'crow-amber-cyber': {
    tile: '#2F291E',
    ink: '#DFC592',
    detail: '#2F291E',
    label: 'Ochre',
  },
  'crow-cyan-radar': {
    tile: '#1E2F32',
    ink: '#B8D4D8',
    detail: '#1E2F32',
    label: 'Steel',
  },
  'crow-rose-governance': {
    tile: '#322124',
    ink: '#DFB9BF',
    detail: '#322124',
    label: 'Oxide',
  },
  'crow-matrix-terminal': {
    tile: '#1E2C24',
    ink: '#B3CEB9',
    detail: '#1E2C24',
    label: 'Moss',
  },
  'crow-cosmos': {
    tile: '#292238',
    ink: '#C9BFE0',
    detail: '#292238',
    label: 'Plum',
  },
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

export function markToneFor(
  variant: string,
): { tile: string; ink: string; detail: string; label: string; isCircle?: boolean } {
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
  size?: 24 | 28 | 32 | 36 | 40;
  selected?: boolean;
  label?: string;
}) {
  const tone = markToneFor(variant);
  const sigilSize = Math.round(size * 0.7);
  const radius = tone.isCircle ? '9999px' : '7px';

  return (
    <span
      role="img"
      aria-label={label ?? 'Workspace mark ' + tone.label}
      style={{
        width: size,
        height: size,
        background: tone.tile,
        border: selected ? '1px solid #465EDB' : '1px solid rgba(128,128,140,0.22)',
        borderRadius: radius,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <CrowSigil
        size={sigilSize}
        tone="custom"
        bodyColor={tone.ink}
        inkColor={tone.detail}
        detail={sigilSize <= 20 ? 'compact' : 'full'}
      />
    </span>
  );
}
