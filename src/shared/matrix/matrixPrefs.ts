// src/shared/matrix/matrixPrefs.ts
//
// Shared, per-user (localStorage) view preferences for EVERY size-matrix surface
// (SO / PO / AR entry, the PO detail Item Matrix, the Inventory Matrix, the ATS
// grid, the read-only PO popover, the vendor-portal PO matrix, …). Two prefs:
//
//   • hide-empty-sizes  — the "green" collapse: hide the all-zero leading/trailing
//                         size columns so only the range actually in play shows.
//                         DEFAULT ON (CEO). Still user-toggleable via the green
//                         first-size header; the choice persists here.
//   • totals-only       — hide the per-size grid entirely and show just the
//                         per-colorway totals (color, total qty, money columns).
//                         DEFAULT OFF. Toggled by the shared MatrixTotalsToggle.
//
// A single shared key per pref means the preference follows the operator across
// every surface. Same-tab updates are broadcast through a window CustomEvent so
// every mounted matrix + toggle re-reads together the instant one flips; the
// native `storage` event keeps other tabs in sync.

import { useEffect, useState } from "react";

/** Green collapse (hide empty leading/trailing size columns). Default ON. */
export const MATRIX_HIDE_EMPTY_KEY = "tanda_matrix_hide_empty_sizes";
/** Totals-only (hide the size grid, show per-colorway totals). Default OFF. */
export const MATRIX_TOTALS_ONLY_KEY = "tanda_matrix_totals_only";

const PREF_EVENT = "tanda-matrix-pref";

/** Read the green-collapse pref (default ON — only an explicit "false" turns it off). */
export function readHideEmptySizes(): boolean {
  try { return localStorage.getItem(MATRIX_HIDE_EMPTY_KEY) !== "false"; } catch { return true; }
}
/** Read the totals-only pref (default OFF — only an explicit "true" turns it on). */
export function readTotalsOnly(): boolean {
  try { return localStorage.getItem(MATRIX_TOTALS_ONLY_KEY) === "true"; } catch { return false; }
}

function writePref(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "true" : "false"); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key } })); } catch { /* ignore */ }
}

/** Subscribe a component to a boolean matrix pref; returns [value, setter].
 *  The setter accepts a value or an updater (like useState) and broadcasts the
 *  change so every other mounted matrix/toggle re-reads it live. */
function useMatrixPref(key: string, read: () => boolean): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(read);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key?: string }>).detail;
      // Custom event carries the key; the native storage event does not — re-read
      // on either (a foreign storage key simply resolves to the same value).
      if (!detail || detail.key == null || detail.key === key) setValue(read());
    };
    window.addEventListener(PREF_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(PREF_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: boolean | ((prev: boolean) => boolean)) => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      writePref(key, next);
      return next;
    });
  };
  return [value, set];
}

/** Green-collapse pref hook (default ON). Drop-in for `useState(false)` at any
 *  matrix surface that owns a `sizesCollapsed` boolean. */
export function useHideEmptySizes(): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  return useMatrixPref(MATRIX_HIDE_EMPTY_KEY, readHideEmptySizes);
}

/** Totals-only pref hook (default OFF). */
export function useTotalsOnly(): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  return useMatrixPref(MATRIX_TOTALS_ONLY_KEY, readTotalsOnly);
}
