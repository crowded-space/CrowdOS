import { useCallback, useRef, useState } from 'react';

// Distance from the bottom (px) inside which the user still counts as
// "at bottom" and the stream keeps following. Matches the reference guide.
export const STREAM_NEAR_BOTTOM_PX = 80;

type ScrollMetrics = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

export function isNearBottomFor(el: ScrollMetrics, px = STREAM_NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}

// Follow-scroll for the streaming message list. User intent is read from
// wheel/touch input only: the `scroll` event also fires for our own
// programmatic pins and must never cancel follow mode. All auto-scrolls use
// `instant` so frames never stack smooth-scroll animations at token rate;
// `smooth` is reserved for the explicit resume (jump-to-latest) action.
export function useStickToBottom<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);
  const userScrolledAwayRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Called after each committed stream flush while following.
  const followStream = useCallback(() => {
    if (!userScrolledAwayRef.current) scrollToBottom('instant');
  }, [scrollToBottom]);

  // Called on user intent only (wheel / touch), never from `scroll`.
  const onUserScrollIntent = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const near = isNearBottomFor(el);
    userScrolledAwayRef.current = !near;
    setIsAtBottom(near);
  }, []);

  // Called when a new assistant message starts, on send, on channel switch,
  // or from the "jump to latest" button. User-triggered, so smooth is fine.
  const resume = useCallback(() => {
    userScrolledAwayRef.current = false;
    setIsAtBottom(true);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  return {
    containerRef,
    followStream,
    resume,
    isAtBottom,
    scrollHandlers: {
      onWheel: onUserScrollIntent,
      onTouchMove: onUserScrollIntent,
    },
  };
}
