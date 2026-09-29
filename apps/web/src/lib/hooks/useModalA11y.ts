'use client';

import { useEffect, useRef } from 'react';

/**
 * Extracted from HelpPanel.tsx's original inline effect (mount-only: focus
 * the panel, wire Esc, restore focus to whatever was focused before the
 * modal opened) so ConnectPanel.tsx can reuse the exact same a11y contract
 * instead of re-implementing it — condition #1 of the fix-chain approval.
 *
 * Returns a ref to attach to the dialog's outer focusable element
 * (`role="dialog"` with `tabIndex={-1}`, same as HelpPanel's `panelRef`).
 * `onClose` is read through a "latest ref" so the effect's empty
 * dependency array never re-captures `document.activeElement` mid-lifecycle.
 */
export function useModalA11y<T extends HTMLElement>(onClose: () => void) {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return panelRef;
}
