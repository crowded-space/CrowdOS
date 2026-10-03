import { useEffect, type RefObject } from 'react';

type focusTargetRef = RefObject<HTMLElement | null>;

type overlayFocusOptions = {
  initialFocusRef?: focusTargetRef;
  fallbackFocusSelector?: string;
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
}

function isInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth;
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true' && isVisible(element),
  );
}

function getFallbackFocus(selector?: string) {
  if (!selector) return null;

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
  return candidates.find(element => isVisible(element) && isInViewport(element))
    || candidates.find(isVisible)
    || candidates[0]
    || null;
}

export function useOverlayFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  options: overlayFocusOptions = {},
) {
  const { initialFocusRef, fallbackFocusSelector } = options;

  useEffect(() => {
    if (!open) return;

    const container = containerRef.current;
    if (!container) return;

    const previousFocus = document.activeElement;
    const restoreTarget = previousFocus instanceof HTMLElement
      && previousFocus !== document.body
      && !container.contains(previousFocus)
      ? previousFocus
      : null;

    const focusInitialTarget = () => {
      const initialTarget = initialFocusRef?.current;
      if (initialTarget?.isConnected) {
        initialTarget.focus();
        return;
      }

      const [firstFocusable] = getFocusableElements(container);
      if (firstFocusable) {
        firstFocusable.focus();
        return;
      }

      container.tabIndex = -1;
      container.focus();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements(container);
      if (focusableElements.length === 0) {
        event.preventDefault();
        container.tabIndex = -1;
        container.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (activeElement === container || !container.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusable : firstFocusable).focus();
        return;
      }

      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    const focusFrame = requestAnimationFrame(focusInitialTarget);
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);

      const fallbackTarget = restoreTarget?.isConnected
        && isVisible(restoreTarget)
        && isInViewport(restoreTarget)
        ? restoreTarget
        : getFallbackFocus(fallbackFocusSelector);

      requestAnimationFrame(() => fallbackTarget?.focus());
    };
  }, [open, containerRef, initialFocusRef, fallbackFocusSelector]);
}
