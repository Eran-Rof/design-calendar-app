// Tangerine T6-3 — ⌘K / Ctrl-K global search hotkey.
//
// Mounts a window keydown listener that toggles the palette open state when
// the operator presses ⌘K (Mac, event.metaKey) or Ctrl-K (Windows/Linux,
// event.ctrlKey). Calls preventDefault so the browser's location-bar focus
// shortcut doesn't fire.
//
// The hook also intercepts Escape while the palette is open and forwards it
// to a close callback so the consumer can centralise lifecycle in one place.

import { useEffect } from "react";

interface GlobalSearchHotkeyOpts {
  /**
   * Current open state. Used so Escape only fires the close callback when
   * the palette is actually open.
   */
  isOpen: boolean;
  /**
   * Called when ⌘K / Ctrl-K is pressed. Receives the desired next open
   * state (i.e. the inverse of the current one).
   */
  onToggle: (nextOpen: boolean) => void;
  /**
   * Called when Escape is pressed while isOpen is true.
   */
  onClose: () => void;
}

/**
 * Listen for the global-search hotkey + Escape. Idempotent: a single
 * keydown listener is attached per mount and torn down on unmount.
 */
export function useGlobalSearchHotkey({ isOpen, onToggle, onClose }: GlobalSearchHotkeyOpts): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ⌘K / Ctrl-K — toggle the palette regardless of focused element.
      // Use lowercase comparison because shift state can flip e.key to "K".
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        onToggle(!isOpen);
        return;
      }
      // Escape — only close when the palette is currently open. We don't
      // preventDefault so other Esc-driven UIs still work when closed.
      if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onToggle, onClose]);
}
