import React from 'react';

export type CrowIconVariant =
  | 'crow-white-rounded'     // White crow in dark squircle
  | 'crow-dark-rounded'      // Dark crow in light squircle
  | 'crow-indigo-circle'     // Circular indigo/violet active variant
  | 'crow-amber-cyber'       // Cyberpunk telemetry amber grid variant
  | 'crow-cyan-radar'        // Intelligence radar neon cyan variant
  | 'crow-rose-governance'   // Crimson authorization monitor shield variant
  | 'crow-matrix-terminal'   // Pure terminal green monospace variant
  | 'crow-cosmos'            // Cosmic dark-slate deep space gradient variant
  | string;                  // Fallback for standard string/emoji mapping

interface CrowIconProps {
  variant: CrowIconVariant;
  className?: string; // Outer container override
  iconSize?: number;  // Inner SVG width/height percentage
}

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
    default:
      // Hash string to map to a variant
      const charCodeSum = emoji.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const variantsList: CrowIconVariant[] = [
        'crow-white-rounded',
        'crow-dark-rounded',
        'crow-indigo-circle',
        'crow-amber-cyber',
        'crow-cyan-radar',
        'crow-rose-governance',
        'crow-matrix-terminal',
        'crow-cosmos'
      ];
      return variantsList[charCodeSum % variantsList.length];
  }
};

export default function CrowIcon({ variant, className = 'w-10 h-10', iconSize = 65 }: CrowIconProps) {
  // Resolve variant if it is a standard string or emoji
  const resolvedVariant = variant.startsWith('crow-') ? variant : mapEmojiToCrowVariant(variant);

  // The majestic noble crow sigil SVG path from the spec sheet
  // Facing left, proud standing posture with custom wing and beak styling
  const renderCrowPath = () => (
    <path
      d="M58 20 C54 18 48 19 43 23 C38 27 35 32 31 35 C28 38 22 36 17 35 C24 38 28 41 31 43 C32 48 34 54 37 59 C40 65 46 72 54 75 C58 77 62 78 66 79 C63 82 59 86 54 88 C49 90 42 92 37 94 C43 94 53 92 59 89 C64 87 67 85 71 81 C73 84 76 86 79 88 C74 90 69 91 64 92 C71 92 78 91 82 88 C85 86 88 83 91 80 L92 78 C93 80 94 83 96 85 C92 87 87 88 81 89 C85 89 91 88 95 85 C98 83 100 80 101 77 C103 70 104 61 102 51 C100 40 95 30 88 22 C81 14 74 12 66 12 C62 12 59 15 58 20 Z"
      fill="currentColor"
    />
  );

  let containerClasses = "relative flex items-center justify-center overflow-hidden transition-all duration-300 rounded-xl ";
  let style: React.CSSProperties = {};

  switch (resolvedVariant) {
    case 'crow-white-rounded':
      containerClasses += "bg-[#111114] border border-zinc-800 text-zinc-100 hover:border-zinc-700 shadow-md";
      break;

    case 'crow-dark-rounded':
      containerClasses += "bg-[#f4f4f5] border border-zinc-200 text-[#09090b] hover:bg-[#eaeaea] shadow-md";
      break;

    case 'crow-indigo-circle':
      containerClasses += "bg-gradient-to-br from-[#1d1e2e] via-[#3359ff]/15 to-indigo-950 border border-[#3359ff]/40 text-[#5f7eff] animate-pulse-slow shadow-[0_0_12px_rgba(51,89,255,0.25)] rounded-lg";
      break;

    case 'crow-amber-cyber':
      containerClasses += "bg-gradient-to-b from-zinc-950 to-amber-950/20 border border-amber-500/30 text-amber-500 hover:border-amber-500/60 shadow-[inset_0_0_10px_rgba(245,158,11,0.05)]";
      break;

    case 'crow-cyan-radar':
      containerClasses += "bg-[#0b1414] border border-cyan-500/25 text-cyan-400 hover:border-cyan-500/50 shadow-[0_0_10px_rgba(34,211,238,0.1)] rounded-lg";
      break;

    case 'crow-rose-governance':
      containerClasses += "bg-gradient-to-br from-zinc-950 via-rose-950/10 to-[#1e0a0f] border border-rose-500/30 text-rose-400 hover:border-rose-500/50 shadow-md";
      break;

    case 'crow-matrix-terminal':
      containerClasses += "bg-zinc-950 border border-emerald-500/20 text-emerald-400 hover:border-emerald-500/40 font-mono shadow-[inset_0_0_8px_rgba(16,185,129,0.1)]";
      break;

    case 'crow-cosmos':
      containerClasses += "bg-[#140e28] border border-indigo-500/25 text-indigo-300 hover:border-indigo-400/50 shadow-[0_0_15px_rgba(99,102,241,0.15)] rounded-lg animate-pulse-slow";
      break;

    default:
      containerClasses += "bg-zinc-900 border border-zinc-800 text-zinc-200 hover:border-zinc-700";
      break;
  }

  return (
    <div 
      className={`${containerClasses} ${className}`} 
      style={style}
    >
      <svg 
        viewBox="0 0 120 120" 
        className="transition-transform duration-300 group-hover:scale-105"
        style={{ width: `${iconSize}%`, height: `${iconSize}%` }}
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        {renderCrowPath()}
      </svg>
    </div>
  );
}

// Wordmark branding components
export function CrowdOSWordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center select-none ${className}`} id="crowd-os-wordmark">
      <img src="/horizontal_logo_dark.png" alt="Crowd OS" className="h-6 object-contain" />
    </div>
  );
}

export function CrowdOSFullLogo({ className = '', variant = 'dark' }: { className?: string, variant?: 'dark' | 'light' }) {
  const isDark = variant === 'dark';
  return (
    <div className={`flex items-center select-none ${className}`} id="crowd-os-full-logo">
      <img src={isDark ? '/horizontal_logo_dark.png' : '/horizontal_logo_light.png'} alt="Crowd OS Logo" className="h-8 object-contain" />
    </div>
  );
}
