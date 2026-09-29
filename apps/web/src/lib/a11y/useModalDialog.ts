'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Learning-mode Step 8 accessibility pass (docs/plans/learning-mode.md) —
 * Esc-to-close + real Tab containment + focus restore for a modal dialog.
 * Extends HelpPanel.tsx's existing Esc/focus-restore pattern (mount-only
 * effect, latest-ref for onClose so it never re-captures
 * document.activeElement mid-lifecycle) with actual focus trapping: Tab/
 * Shift+Tab cycle within the dialog's focusable elements instead of
 * escaping into the page behind the overlay.
 *
 * Attach the returned ref to the dialog's outer element (role="dialog",
 * tabIndex={-1}). On mount, focus moves to the dialog's first focusable
 * child (falling back to the dialog itself if none); on unmount, focus
 * returns to whatever was focused before the dialog opened (the trigger).
 */
export function useModalA11y(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? dialog)?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return dialogRef;
}
