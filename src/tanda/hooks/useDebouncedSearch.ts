// useDebouncedSearch — Operator ask #8 primitive (universal dynamic search).
//
// A controlled-style hook for "search-as-you-type" inputs throughout the app.
// The synchronous `value` binds to the input (so typing is responsive); the
// `debouncedValue` updates after `delay` ms of inactivity and is what callers
// should pipe into their filter / query effect. Matches the 200ms cadence
// used by the T6 GlobalSearchPalette so the whole app feels consistent.
//
// No external deps. Safe under React 18 strict-mode double-invocation: the
// effect's cleanup clears the pending timer before the next effect runs.

import { useCallback, useEffect, useRef, useState } from "react";

export type UseDebouncedSearch = {
  /** Current input value — updates synchronously on each keystroke. */
  value: string;
  /** Debounced value — updates after `delay` ms of no further keystrokes. */
  debouncedValue: string;
  /** Setter for the input value. Accepts a string or an updater fn. */
  setValue: (next: string | ((prev: string) => string)) => void;
  /** Clear both `value` and `debouncedValue` immediately (no debounce). */
  clear: () => void;
};

/**
 * Hook that splits an input string into a synchronous `value` (for the
 * input's `value` prop) and a `debouncedValue` (for filter / query effects).
 *
 * @param initial - Initial input value. Defaults to "".
 * @param delay   - Debounce window in ms. Defaults to 200 to match
 *                  GlobalSearchPalette.
 */
export function useDebouncedSearch(
  initial: string = "",
  delay: number = 200,
): UseDebouncedSearch {
  const [value, setValueState] = useState<string>(initial);
  const [debouncedValue, setDebouncedValue] = useState<string>(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push the synchronous value into the debounced slot after `delay` ms.
  // If the synchronous value matches the debounced value already (e.g. after
  // a clear or rapid back-and-forth), skip scheduling so callers don't fire
  // a redundant setState/effect.
  useEffect(() => {
    if (value === debouncedValue) return;
    const t = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    timerRef.current = t;
    return () => {
      clearTimeout(t);
      if (timerRef.current === t) timerRef.current = null;
    };
  }, [value, delay, debouncedValue]);

  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      setValueState((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setValueState("");
    setDebouncedValue("");
  }, []);

  return { value, debouncedValue, setValue, clear };
}

export default useDebouncedSearch;
