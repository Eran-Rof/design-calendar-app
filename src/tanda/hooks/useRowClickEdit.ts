// src/tanda/hooks/useRowClickEdit.ts
//
// Universal "click-anywhere-on-row to edit" primitive (operator ask #4).
//
// Adopting panels swap their per-row <tr> for the props returned by
// `getRowProps(row)`. The hook handles three concerns that every panel
// gets wrong on its first try:
//
//   1. Modifier-key / middle-click fall-through. Ctrl/Cmd/Shift/Alt clicks
//      and middle-clicks (button === 1) must NOT open the edit modal — the
//      operator is trying to open a link in a new tab or otherwise interact
//      with a child anchor. The hook short-circuits in those cases.
//
//   2. Cell-button bubbling. Per-row action buttons (Edit / Delete /
//      Reverse) live INSIDE the <tr>. Their `onClick={(e) => e.stopPropagation()}`
//      is still required on the button side, but if a panel forgets to add
//      it, this hook detects clicks that originated on a <button>,
//      <a href>, <input>, <select>, <textarea>, or element with role=button
//      (the "interactive element ancestor" check) and silently skips them.
//
//   3. Keyboard accessibility. Tabbing onto a row and pressing Enter or
//      Space activates the same edit flow. tabIndex=0 + role="button" is
//      applied so screen readers announce the row as clickable.
//
// The hook also returns an `onClick` that wires up an optional
// `ScrollHighlightRow` registry callback so the most-recently-clicked row
// can be highlighted as the operator scrolls away from it (see
// ScrollHighlightRow.tsx).

import { useCallback, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

/** Selector that matches any interactive descendant of a <tr>. */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [data-row-click-skip="true"]';

/** Options for the hook. */
export interface UseRowClickEditOptions<TRow> {
  /**
   * Called when the operator clicks (or keyboard-activates) a row.
   * The hook guarantees this fires AT MOST ONCE per gesture and never
   * fires for modifier-key or interactive-element clicks.
   */
  onRowClick: (row: TRow) => void;
  /**
   * Optional stable identity extractor. Used by ScrollHighlightRow so the
   * highlight survives data re-fetches when array indices shuffle. Defaults
   * to `String(row.id)` if the row has an `id` property, otherwise the
   * raw row reference.
   */
  getRowId?: (row: TRow) => string;
  /**
   * Optional callback invoked just before `onRowClick`. Used by the
   * ScrollHighlightRow primitive to record the last-clicked row id so the
   * fade animation knows which row to track. Most callers should leave
   * this undefined and let ScrollHighlightRow wire it.
   */
  onBeforeRowClick?: (rowId: string) => void;
  /**
   * ARIA label template. Defaults to "Open row for edit". Callers can pass
   * a function for per-row labels (e.g. `(r) => `Edit account ${r.code}``).
   */
  ariaLabel?: string | ((row: TRow) => string);
  /**
   * Optional disabled predicate. When it returns true for a row, the row
   * still renders but clicks are no-ops and no aria/tabindex is applied
   * (the row behaves like a plain non-interactive row).
   */
  disabled?: (row: TRow) => boolean;
}

/** Props returned by `getRowProps(row)` — spread these onto a <tr>. */
export interface RowProps {
  onClick: (e: ReactMouseEvent<HTMLTableRowElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLTableRowElement>) => void;
  role: "button" | undefined;
  tabIndex: number | undefined;
  className: string;
  "aria-label": string | undefined;
  "data-row-id": string | undefined;
  style: { cursor: "pointer" | undefined };
}

export interface UseRowClickEditResult<TRow> {
  getRowProps: (row: TRow) => RowProps;
  /** The id of the row that was most recently clicked, or null. */
  lastClickedRowId: () => string | null;
}

function defaultGetRowId<TRow>(row: TRow): string {
  if (row && typeof row === "object" && "id" in row) {
    const id = (row as { id: unknown }).id;
    if (id != null) return String(id);
  }
  return String(row);
}

/**
 * Returns true iff `target` (the event target) is itself, or is nested
 * inside, an interactive element that lives BELOW `boundary` (the <tr>
 * the hook is attached to). The boundary check is important: the row
 * itself has `role="button"` once we mount it, so a naive
 * `closest(INTERACTIVE_SELECTOR)` would always match the row and the
 * primary click would never fire.
 */
function isInteractiveTarget(
  target: EventTarget | null,
  boundary?: Element | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  if (!hit) return false;
  // If the matched element is the boundary itself (the <tr>), it doesn't
  // count — that IS the clickable row.
  if (boundary && hit === boundary) return false;
  return true;
}

/**
 * Public hook. See file header for the full contract.
 *
 * @example
 *   const { getRowProps } = useRowClickEdit<Account>({
 *     onRowClick: (a) => setEditing(a),
 *     ariaLabel: (a) => `Edit account ${a.code}`,
 *   });
 *   // ...
 *   <tr {...getRowProps(account)}> ... </tr>
 */
export function useRowClickEdit<TRow>(
  options: UseRowClickEditOptions<TRow>,
): UseRowClickEditResult<TRow> {
  const {
    onRowClick,
    getRowId = defaultGetRowId,
    onBeforeRowClick,
    ariaLabel = "Open row for edit",
    disabled,
  } = options;

  const lastIdRef = useRef<string | null>(null);

  const trigger = useCallback(
    (row: TRow) => {
      const id = getRowId(row);
      lastIdRef.current = id;
      if (onBeforeRowClick) onBeforeRowClick(id);
      onRowClick(row);
    },
    [getRowId, onBeforeRowClick, onRowClick],
  );

  const getRowProps = useCallback(
    (row: TRow): RowProps => {
      const isDisabled = disabled ? disabled(row) : false;
      const id = getRowId(row);
      const label =
        typeof ariaLabel === "function" ? ariaLabel(row) : ariaLabel;

      if (isDisabled) {
        return {
          onClick: () => {},
          onKeyDown: () => {},
          role: undefined,
          tabIndex: undefined,
          className: "tanda-row tanda-row--disabled",
          "aria-label": undefined,
          "data-row-id": id,
          style: { cursor: undefined },
        };
      }

      return {
        onClick: (e: ReactMouseEvent<HTMLTableRowElement>) => {
          // 1. Modifier keys + non-primary mouse buttons fall through. The
          //    operator is opening a link in a new tab or otherwise
          //    interacting with a child element.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          if (e.button !== 0) return;
          // 2. Clicks that originate on a button/link/input inside the row
          //    do not trigger the row click — the inner widget handles it.
          if (isInteractiveTarget(e.target, e.currentTarget)) return;
          trigger(row);
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLTableRowElement>) => {
          // Keyboard activation: Enter or Space on the <tr> itself.
          if (e.key !== "Enter" && e.key !== " ") return;
          // If focus is on a child interactive element, let it handle the
          // key (e.g. Space toggles a checkbox).
          if (
            e.target !== e.currentTarget &&
            isInteractiveTarget(e.target as EventTarget, e.currentTarget)
          ) {
            return;
          }
          e.preventDefault();
          trigger(row);
        },
        role: "button",
        tabIndex: 0,
        className: "tanda-row tanda-row--clickable",
        "aria-label": label,
        "data-row-id": id,
        style: { cursor: "pointer" },
      };
    },
    [ariaLabel, disabled, getRowId, trigger],
  );

  const lastClickedRowId = useCallback(() => lastIdRef.current, []);

  return { getRowProps, lastClickedRowId };
}

// Internal export for tests — exposes the selector + helper so the unit
// tests can assert exactly which DOM nodes are treated as "interactive".
export const __internal = {
  INTERACTIVE_SELECTOR,
  isInteractiveTarget,
  defaultGetRowId,
};
