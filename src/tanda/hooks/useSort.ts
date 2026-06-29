// src/tanda/hooks/useSort.ts
//
// Universal client-side column-sort primitive — operator ask (2026-06-04):
//   "Add per-column up/down sort to the Tangerine table panels. Click a
//    header to toggle asc → desc → off."
//
// A tiny, dependency-free hook that any Tangerine table panel can drop in
// alongside the existing `useTablePrefs` column-visibility primitive. It is
// purely additive: a panel keeps rendering its rows exactly as before, but
// renders `sorted` instead of the raw array. Order only changes once the
// user clicks a sortable header.
//
// Tri-state behaviour (modelled on src/tanda/views/GridView.tsx ~213-291 and
// src/inventory-planning/panels/wholesale-planning/Th.tsx):
//   1st click on a column → ascending
//   2nd click (same col)  → descending
//   3rd click (same col)  → cleared (back to the panel's natural order)
//   click a different col  → that column ascending
//
// Null-safe comparator: numbers compare numerically, strings via
// localeCompare, and null / undefined / "" sort LAST in BOTH directions so
// blanks always cluster at the bottom of the list rather than flipping to the
// top on a descending sort.
//
// Column value resolution:
//   value(key, row) = accessors[key]?.(row) ?? (row as any)[key]
// i.e. by default a column key reads the same-named scalar field straight off
// the row. Panels only supply an `accessors` entry for a column whose key does
// not map 1:1 to a row field (and only when the mapping is trivially correct).
//
// Usage in a panel:
//
//   const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
//     persistKey: "tangerine:paymentterms:sort",
//   });
//   // …
//   <SortableTh label="Code" sortKey="code" activeKey={sortKey}
//     dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
//   // …
//   {sorted.map(r => …)}

import { useCallback, useEffect, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

export interface UseSortOptions<T> {
  /**
   * When set, the current {key, dir} is persisted to localStorage under this
   * key so the user's sort survives a page reload. Per-panel — give every
   * panel a distinct key (e.g. "tangerine:paymentterms:sort").
   */
  persistKey?: string;
  /**
   * Optional per-column value extractors. Only needed when a column key does
   * not read a same-named scalar field off the row. Return a number, string,
   * boolean, Date, null, or undefined.
   */
  accessors?: Record<string, (row: T) => unknown>;
}

export interface UseSortResult<T> {
  /** Rows in the active sort order (or the input order when unsorted). */
  sorted: T[];
  /** The column currently sorted on, or null when unsorted. */
  sortKey: string | null;
  /** Direction of the active sort. Meaningless when sortKey is null. */
  sortDir: SortDir;
  /** Tri-state header click: asc → desc → off for the same key. */
  onHeaderClick: (key: string) => void;
}

interface PersistShape {
  key: string | null;
  dir: SortDir;
}

function readPersisted(persistKey: string | undefined): PersistShape | null {
  if (!persistKey) return null;
  try {
    const raw = localStorage.getItem(persistKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    const key = typeof parsed.key === "string" ? parsed.key : null;
    const dir: SortDir = parsed.dir === "desc" ? "desc" : "asc";
    return { key, dir };
  } catch {
    return null;
  }
}

/**
 * Null-safe, type-aware comparator producing an ascending ordering. Empty
 * values (null / undefined / "") always sort LAST; the descending pass is
 * derived by negating the non-empty comparisons only (see compareWithDir).
 */
function emptyOf(v: unknown): boolean {
  return v == null || v === "";
}

export function baseCompare(av: unknown, bv: unknown): number {
  // Numbers (and numeric-coercible) compare numerically.
  if (typeof av === "number" && typeof bv === "number") {
    if (Number.isNaN(av) && Number.isNaN(bv)) return 0;
    if (Number.isNaN(av)) return 1;
    if (Number.isNaN(bv)) return -1;
    return av - bv;
  }
  // Dates compare by timestamp.
  if (av instanceof Date && bv instanceof Date) {
    return av.getTime() - bv.getTime();
  }
  // Booleans: false < true.
  if (typeof av === "boolean" && typeof bv === "boolean") {
    return av === bv ? 0 : av ? 1 : -1;
  }
  // Fallback: locale-aware string compare (numeric-aware so "Item 2" < "Item 10").
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Pure, stable, null-safe sort. Empties (null / undefined / "") always sort
 * last. Exported for unit testing and any non-React caller.
 */
export function sortRows<T>(
  rows: T[],
  sortKey: string | null,
  sortDir: SortDir,
  getValue: (key: string, row: T) => unknown,
): T[] {
  if (!sortKey) return rows;
  const dirMul = sortDir === "asc" ? 1 : -1;
  const decorated = rows.map((row, i) => ({ row, i, v: getValue(sortKey, row) }));
  decorated.sort((a, b) => {
    const aEmpty = emptyOf(a.v);
    const bEmpty = emptyOf(b.v);
    if (aEmpty && bEmpty) return a.i - b.i;
    if (aEmpty) return 1; // empties last, regardless of direction
    if (bEmpty) return -1;
    const c = baseCompare(a.v, b.v) * dirMul;
    return c !== 0 ? c : a.i - b.i;
  });
  return decorated.map((d) => d.row);
}

/**
 * React hook backing the universal column-sort primitive.
 *
 * @param rows  The (already filtered) rows the panel renders.
 * @param opts  Optional persistKey + per-column accessors.
 */
export function useSort<T>(rows: T[], opts?: UseSortOptions<T>): UseSortResult<T> {
  const persistKey = opts?.persistKey;
  const accessors = opts?.accessors;

  const initial = useMemo(() => readPersisted(persistKey), [persistKey]);
  // Single {key, dir} state so the tri-state transition is computed atomically
  // in one updater (no nested setters → safe under React StrictMode).
  const [sort, setSort] = useState<PersistShape>(() => initial ?? { key: null, dir: "asc" });
  const { key: sortKey, dir: sortDir } = sort;

  // Persist {key, dir} whenever it changes (best-effort; ignore quota / SSR).
  useEffect(() => {
    if (!persistKey) return;
    try {
      if (sortKey == null) localStorage.removeItem(persistKey);
      else localStorage.setItem(persistKey, JSON.stringify({ key: sortKey, dir: sortDir }));
    } catch {
      /* ignore */
    }
  }, [persistKey, sortKey, sortDir]);

  const onHeaderClick = useCallback((key: string) => {
    setSort((prev) => {
      // New column → start ascending.
      if (prev.key !== key) return { key, dir: "asc" };
      // Same column → asc → desc → off.
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" }; // third click clears
    });
  }, []);

  const value = useCallback(
    (key: string, row: T): unknown => {
      const acc = accessors?.[key];
      if (acc) return acc(row);
      return (row as Record<string, unknown>)[key];
    },
    [accessors],
  );

  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir, value),
    [rows, sortKey, sortDir, value],
  );

  return { sorted, sortKey, sortDir, onHeaderClick };
}

export default useSort;
