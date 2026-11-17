import React from 'react';
import { CrowSigil, CrowdOSLockup } from './CrowSigil';

export type CrowIconVariant =
  | 'crow-white-rounded'     // White crow in obsidian squircle
  | 'crow-dark-rounded'      // Obsidian crow in light squircle
  | 'crow-indigo-circle'     // White crow on electric cobalt circle
  | 'crow-amber-cyber'       // Ochre / amber restrained architectural tile
  | 'crow-cyan-radar'        // Steel / cyan architectural tile
  | 'crow-rose-governance'   // Oxide crimson governance tile
  | 'crow-matrix-terminal'   // Moss / terminal emerald tile
  | 'crow-cosmos'            // Deep plum / slate tile
  | string;                  // Fallback for standard string/emoji mapping

interface CrowIconProps {
  variant: CrowIconVariant;
  className?: string; // Outer container override
  iconSize?: number;  // Inner SVG width/height percentage
}

const VARIANT_STYLES: Record<
  string,
  { radiusClass: string; tile: string; border: string; body: string; ink: string }
> = {
  'crow-white-rounded': {
    radiusClass: 'rounded-xl',
    tile: '#141418',
    border: 'rgba(255,255,255,0.12)',
    body: '#FAFAFA',
    ink: '#141418',
  },
  'crow-dark-rounded': {
    radiusClass: 'rounded-xl',
    tile: '#F4F4F5',
    border: 'rgba(11,11,14,0.14)',
    body: '#0B0B0E',
    ink: '#F4F4F5',
  },
  'crow-indigo-circle': {
    radiusClass: 'rounded-full',
    tile: '#4B55FF',
    border: 'rgba(93,102,255,0.6)',
    body: '#FFFFFF',
    ink: '#4B55FF',
  },
  'crow-amber-cyber': {
    radiusClass: 'rounded-xl',
    tile: '#2F291E',
    border: 'rgba(245,158,11,0.28)',
    body: '#E8CC92',
    ink: '#2F291E',
  },
  'crow-cyan-radar': {
    radiusClass: 'rounded-xl',
    tile: '#1E2F32',
    border: 'rgba(6,182,212,0.28)',
    body: '#B8D4D8',
    ink: '#1E2F32',
  },
  'crow-rose-governance': {
    radiusClass: 'rounded-xl',
    tile: '#322124',
    border: 'rgba(244,63,94,0.28)',
    body: '#E8B8C0',
    ink: '#322124',
  },
  'crow-matrix-terminal': {
    radiusClass: 'rounded-xl',
    tile: '#1E2C24',
    border: 'rgba(16,185,129,0.28)',
    body: '#B3CEB9',
    ink: '#1E2C24',
  },
  'crow-cosmos': {
    radiusClass: 'rounded-xl',
    tile: '#292238',
    border: 'rgba(129,140,248,0.28)',
    body: '#CDC2E6',
    ink: '#292238',
  },
};

const VARIANTS_LIST: CrowIconVariant[] = [
  'crow-white-rounded',
  'crow-dark-rounded',
  'crow-indigo-circle',
  'crow-amber-cyber',
  'crow-cyan-radar',
  'crow-rose-governance',
  'crow-matrix-terminal',
  'crow-cosmos',
];

// Map of standard workspace emojis to thematic Crow variants
export const mapEmojiToCrowVariant = (emoji: string): CrowIconVariant => {
  switch (emoji) {
    case '🔮': return 'crow-white-rounded';
    case '🛡️': return 'crow-rose-governance';
    case '⚡': return 'crow-amber-cyber';
    case '🛸': return 'crow-cyan-radar';
    case '🧬': return 'crow-indigo-circle';
    case '⚙️': return 'crow-matrix-terminal';
    case '🌌': return 'crow-cosmos';
    case '💼': return 'crow-dark-rounded';
    default: {
      const charCodeSum = emoji.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return VARIANTS_LIST[charCodeSum % VARIANTS_LIST.length];
    }
  }
};

export default function CrowIcon({
  variant,
  className = 'w-10 h-10',
  iconSize = 68,
}: CrowIconProps) {
  const resolvedVariant = variant?.startsWith('crow-')
    ? variant
    : mapEmojiToCrowVariant(variant || '');
  const styleSpec = VARIANT_STYLES[resolvedVariant] ?? VARIANT_STYLES['crow-white-rounded'];

  return (
    <div
      style={{
        backgroundColor: styleSpec.tile,
        borderColor: styleSpec.border,
      }}
      className={`relative flex items-center justify-center overflow-hidden border transition-colors duration-150 ${styleSpec.radiusClass} ${className}`}
    >
      <div
        className="flex items-center justify-center"
        style={{ width: `${iconSize}%`, height: `${iconSize}%` }}
      >
        <CrowSigil
          size="100%"
          tone="custom"
          bodyColor={styleSpec.body}
          inkColor={styleSpec.ink}
          detail="full"
        />
      </div>
    </div>
  );
}

// Vector Wordmark & Lockup branding components (replaces legacy raster PNGs)
export function CrowdOSWordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center select-none ${className}`} id="crowd-os-wordmark">
      <CrowdOSLockup layout="horizontal" size="sm" tone="auto" />
    </div>
  );
}

export function CrowdOSFullLogo({
  className = '',
  variant,
}: {
  className?: string;
  variant?: 'dark' | 'light' | 'auto';
}) {
  return (
    <div className={`flex items-center select-none ${className}`} id="crowd-os-full-logo">
      <CrowdOSLockup layout="horizontal" size="md" tone={variant ?? 'auto'} />
    </div>
  );
}
