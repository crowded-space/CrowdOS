import React from 'react';
import { CrowSigil } from './CrowSigil';

interface AgentAvatarProps {
  avatar?: string;
  level?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_MAP = {
  xs: { box: 'w-6 h-6 rounded-md', sigil: 16, text: 'text-xs' },
  sm: { box: 'w-8 h-8 rounded-lg', sigil: 21, text: 'text-sm' },
  md: { box: 'w-9 h-9 rounded-lg', sigil: 24, text: 'text-[15px]' },
  lg: { box: 'w-12 h-12 rounded-xl', sigil: 32, text: 'text-xl' },
  xl: { box: 'w-20 h-20 rounded-2xl', sigil: 52, text: 'text-3xl' },
} as const;

const TIER_RING: Record<number, { border: string; bg: string; body?: string; ink?: string }> = {
  0: { border: 'border-cyan-500/35', bg: 'bg-zinc-950' },
  1: { border: 'border-rose-500/35', bg: 'bg-zinc-950' },
  2: { border: 'border-indigo-500/40', bg: 'bg-zinc-950' },
  3: { border: 'border-emerald-500/30', bg: 'bg-zinc-950' },
};

const DEFAULT_SYSTEM_AVATARS = new Set(['🤖', '🦅', '🐦', '🦉']);

/**
 * Determines whether an avatar string is an explicit user-customized override
 * rather than an unset or legacy system tier placeholder ('🤖', '🦅', '🐦', '🦉').
 */
export function hasCustomAvatarOverride(avatar?: string | null): boolean {
  const trimmed = typeof avatar === 'string' ? avatar.trim() : '';
  return trimmed.length > 0 && !DEFAULT_SYSTEM_AVATARS.has(trimmed);
}

/**
 * Shared agent avatar used across RosterPanel, AgentRow, AgentProfileModal,
 * AgentStudioModal, and AgentMessage. Renders the Crow Sigil SVG by default
 * (with clean dark/light theme inversion) and respects custom emoji overrides.
 */
export function AgentAvatar({
  avatar,
  level = 3,
  size = 'md',
  className = '',
}: AgentAvatarProps) {
  const dim = SIZE_MAP[size];
  const tier = TIER_RING[level] ?? { border: 'border-zinc-800', bg: 'bg-zinc-950' };
  const isCustom = hasCustomAvatarOverride(avatar);

  return (
    <span
      className={`relative inline-flex items-center justify-center shrink-0 select-none border ${tier.bg} ${tier.border} ${dim.box} ${dim.text} ${className}`}
      aria-hidden="true"
    >
      {isCustom ? (
        <span className="leading-none">{avatar}</span>
      ) : (
        <CrowSigil
          size={dim.sigil}
          tone="auto"
          detail={dim.sigil <= 18 ? 'compact' : 'full'}
        />
      )}
    </span>
  );
}

export default AgentAvatar;
