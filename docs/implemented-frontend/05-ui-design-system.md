# UI/UX Design System

---

## Colors

brand-bg: #0A0A0B | brand-nav: #0E0E10 | brand-sidebar: #111114
brand-card: #1C1C1F | brand-border: #1F1F23 | brand-border-muted: #2D2D32
brand-primary: #3359FF | brand-primary-hover: #5575FF

Custom theme defined via Tailwind v4 @theme directive.

---

## Level Color Theme

L0 (Surveillance) -> Cyan: text-cyan-400, bg-cyan-500/10, border-cyan-500/30
L1 (Admin)        -> Rose: text-rose-400, bg-rose-500/10, border-rose-500/30
L2 (Coordinator)  -> Indigo: text-indigo-400, bg-indigo-500/10, border-indigo-500/30
L3 (Worker)       -> Emerald: text-emerald-400, bg-emerald-500/10, border-emerald-500/30

---

## Status Indicator Colors (OKLCH)

active     -> oklch(0.65 0.18 145) green + glow
idle       -> oklch(0.55 0.08 90) amber
thinking   -> oklch(0.62 0.15 250) indigo + pulse glow
delegating -> oklch(0.60 0.15 290) purple + glow
executing  -> oklch(0.60 0.12 200) teal + glow
sleeping   -> zinc-500 gray

---

## Typography

Body: Inter (sans-serif) via Google Fonts
Code: JetBrains Mono (monospace) via Google Fonts

---

## CSS Animations (6 keyframes)

slide-in-left    250ms | cubic-bezier(0.16,1,0.3,1) | Mobile drawer left
slide-in-right   250ms | cubic-bezier(0.16,1,0.3,1) | Mobile drawer right
fade-in-up       300ms | cubic-bezier(0.16,1,0.3,1) | Modal/panel entrances
scale-in         200ms | cubic-bezier(0.16,1,0.3,1) | Dropdowns, popovers
slide-up         300ms | cubic-bezier(0.16,1,0.3,1) | Sandbox preview popup
fade             150ms | ease-out                   | Lightbox overlays

Utility classes: .animate-slide-up, .animate-slide-in-left, .animate-slide-in-right, .animate-fade-in-up, .animate-scale-in, .animate-fade-in

---

## Layout

- Desktop: 3-panel (sidebar 245px | chat flex-1 | right 260px)
- Mobile: single-panel with slide drawers (md:hidden left/right)
- Bottom nav appears on mobile only (md:hidden)
- All scrollbars hidden globally (.scrollbar-none default)
- Thin scrollbars available via .scrollbar-thin class

---

## Key UX Patterns

1. Dark theme only - no light mode toggle
2. Discord-like channel/category tree with collapse
3. Unread counts with red badges, mention dots (rose circles)
4. Hash icon prefix for channels
5. @mention pill rendering in messages and autocomplete dropdown
6. File drag-and-drop onto composer area
7. Image lightbox on click (fullscreen overlay)
8. Empty channel welcome states
9. Confirmation dialogs before destructive actions (delete/clear/archive)
10. AnimatePresence for all modal/menu transitions
