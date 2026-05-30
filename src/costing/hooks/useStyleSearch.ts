// useStyleSearch — debounced /api/internal/costing/search/styles wrapper.
//
// Returns { rows, loading, search } so the StylePickerCell can fire a
// search(q) on each keystroke without flooding the server. Generic enough
// to reuse from other style-picking surfaces if they emerge later.

import { useCallback, useEffect, useRef, useState } from "react";
import { searchStyles, type StyleHit } from "../services/costingApi";

const DEBOUNCE_MS = 200;

export function useStyleSearch() {
  const [rows, setRows] = useState<StyleHit[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const search = useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (ctrl.current) ctrl.current.abort();
    const trimmed = (q || "").trim();
    // Fire unconditionally — handler returns the first 25 active styles
    // when q is empty so the picker can show options on focus before the
    // operator types anything.
    setLoading(true);
    timer.current = setTimeout(async () => {
      const ac = new AbortController();
      ctrl.current = ac;
      try {
        const hits = await searchStyles(trimmed, ac.signal);
        if (!ac.signal.aborted) setRows(hits);
      } catch {
        if (!ac.signal.aborted) setRows([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (ctrl.current) ctrl.current.abort();
    };
  }, []);

  return { rows, loading, search };
}

// Vendor search shares the same debounce pattern.
import { searchVendors, type VendorHit } from "../services/costingApi";

export function useVendorSearch() {
  const [rows, setRows] = useState<VendorHit[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const search = useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (ctrl.current) ctrl.current.abort();
    const trimmed = (q || "").trim();
    // Unlike style search, vendor search ALWAYS fires — the handler returns
    // the first 25 vendors when q is empty, which lets the operator browse
    // existing vendors by clicking the field without having to type first.
    setLoading(true);
    timer.current = setTimeout(async () => {
      const ac = new AbortController();
      ctrl.current = ac;
      try {
        const hits = await searchVendors(trimmed, { signal: ac.signal });
        if (!ac.signal.aborted) setRows(hits);
      } catch {
        if (!ac.signal.aborted) setRows([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (ctrl.current) ctrl.current.abort();
    };
  }, []);

  return { rows, loading, search };
}
