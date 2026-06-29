// Universal Column Visibility primitive — operator ask #1 (2026-05-30).
//
//   "In all user viewable windows with columns, add ability to view or
//    hide any column. Add save UI function so each user can save their
//    own UI."
//
// Exports a tiny self-contained hook + popover button that any Tangerine
// table panel can drop in next to its search input. The hook reads/writes
// per-user prefs via the existing user_preferences table (key namespace:
// `table_visibility`). Persistence is debounced so a rapid toggle storm
// emits at most one PUT per ~400ms.
//
// Storage shape inside user_preferences.value at key='table_visibility':
//
//   {
//     tables: {
//       "tanda.style_master": ["base_fabric", "is_apparel"],
//       "tanda.style_master_modal": [],
//       ...
//     },
//     v: 1
//   }
//
// The hidden-column set is stored (not the visible set) so newly added
// columns appear by default, exactly matching the operator's "fresh
// columns always show up" expectation.
//
// Usage in a panel:
//
//   const TABLE_KEY = "tanda.style_master";
//   const ALL_COLUMNS: ColumnDef[] = [
//     { key: "style_code", label: "Style Number" },
//     { key: "style_name", label: "Style Name" },
//     // …
//   ];
//   const { visibleColumns, toggleColumn, resetToDefault } =
//     useTablePrefs(TABLE_KEY, ALL_COLUMNS);
//
//   <TablePrefsButton
//     tableKey={TABLE_KEY}
//     columns={ALL_COLUMNS}
//     visibleColumns={visibleColumns}
//     onToggle={toggleColumn}
//     onReset={resetToDefault}
//   />
//
//   <th hidden={!visibleColumns.has("base_fabric")}>Base Fabric</th>
//   <td hidden={!visibleColumns.has("base_fabric")}>{row.base_fabric}</td>
//
// `<th hidden>` + `<td hidden>` works cleanly with native table layout —
// browsers collapse the column entirely when every cell is hidden.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────

export type ColumnDef = {
  key: string;
  label: string;
  /** Defaults to true. Set false to start a column hidden by default. */
  defaultVisible?: boolean;
};

export interface UseTablePrefs {
  /** Set of column keys currently visible. Recomputed on every change. */
  visibleColumns: Set<string>;
  /** Toggle one column's visibility. Optimistic; persisted debounced. */
  toggleColumn: (columnKey: string) => void;
  /** Set every column visible (true) or hidden (false). Optimistic + debounced. */
  setAllVisible: (visible: boolean) => void;
  /** Restore the default visibility set (clears the hidden array for this table). */
  resetToDefault: () => void;
  /** True until the first GET /preferences settles. */
  isLoading: boolean;
  /** Last persistence error, if any. Cleared on next successful save. */
  error: string | null;
}

// ── Shared module-level cache ────────────────────────────────────────────

interface CacheShape {
  /** Map of tableKey → set of HIDDEN column keys (storing hidden, not visible). */
  hiddenByTable: Map<string, Set<string>>;
  status: "unloaded" | "loading" | "ready" | "error";
  isLoading: boolean;
  error: string | null;
}

const cache: CacheShape = {
  hiddenByTable: new Map(),
  status: "unloaded",
  isLoading: false,
  error: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* keep notifying others */ }
  }
}

let inFlight: Promise<void> | null = null;

interface TableVisibilityValue {
  tables?: Record<string, unknown>;
}

async function fetchAllPrefs(): Promise<void> {
  if (inFlight) return inFlight;
  cache.status = "loading";
  cache.isLoading = true;
  cache.error = null;
  notify();
  inFlight = (async () => {
    try {
      const res = await fetch("/api/internal/users/me/preferences", { method: "GET" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`GET /preferences failed (${res.status}): ${txt || res.statusText}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const tvRow = (json.table_visibility ?? null) as TableVisibilityValue | null;
      const map = new Map<string, Set<string>>();
      if (tvRow && tvRow.tables && typeof tvRow.tables === "object") {
        for (const [tableKey, hidden] of Object.entries(tvRow.tables)) {
          if (Array.isArray(hidden)) {
            map.set(
              tableKey,
              new Set(hidden.filter((k): k is string => typeof k === "string")),
            );
          }
        }
      }
      cache.hiddenByTable = map;
      cache.status = "ready";
      cache.error = null;
    } catch (e) {
      cache.status = "error";
      cache.error = e instanceof Error ? e.message : String(e);
    } finally {
      cache.isLoading = false;
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

// Debounced persistence — coalesces a burst of toggles into a single PUT.
// One timer per tableKey keeps panels independent.
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 400;

async function persistTable(tableKey: string): Promise<void> {
  const hidden = Array.from(cache.hiddenByTable.get(tableKey) ?? []);
  try {
    const res = await fetch("/api/internal/users/me/preferences/table-visibility", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tables: { [tableKey]: hidden } }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`PUT table-visibility failed (${res.status}): ${txt || res.statusText}`);
    }
    cache.error = null;
  } catch (e) {
    cache.error = e instanceof Error ? e.message : String(e);
    notify();
    throw e;
  }
}

function schedulePersist(tableKey: string): void {
  const existing = flushTimers.get(tableKey);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    flushTimers.delete(tableKey);
    void persistTable(tableKey).catch(() => { /* error already captured on cache */ });
  }, PERSIST_DEBOUNCE_MS);
  flushTimers.set(tableKey, t);
}

// ── Hook ─────────────────────────────────────────────────────────────────

/**
 * React hook backing the universal column-visibility primitive.
 *
 * @param tableKey     Stable id for this panel's table. Use a "namespace.panel"
 *                     shape (e.g. "tanda.style_master") to keep the per-user
 *                     preferences map readable.
 * @param allColumns   Static column registry for this panel. `defaultVisible`
 *                     defaults to true; the hidden-set is what gets persisted.
 */
export function useTablePrefs(
  tableKey: string,
  allColumns: ColumnDef[],
): UseTablePrefs {
  const [, force] = useState(0);

  useEffect(() => {
    const listener: Listener = () => force((n) => n + 1);
    listeners.add(listener);
    if (cache.status === "unloaded") {
      void fetchAllPrefs();
    }
    return () => { listeners.delete(listener); };
  }, []);

  // Columns that should default to hidden (defaultVisible === false) are
  // applied IN ADDITION to whatever the user has explicitly hidden, but
  // only when the user has no recorded entry yet for this tableKey.
  const defaultHidden = useMemo(() => {
    const s = new Set<string>();
    for (const c of allColumns) {
      if (c.defaultVisible === false) s.add(c.key);
    }
    return s;
  }, [allColumns]);

  const visibleColumns = useMemo(() => {
    const stored = cache.hiddenByTable.get(tableKey);
    const hidden = stored ?? defaultHidden;
    const out = new Set<string>();
    for (const c of allColumns) {
      if (!hidden.has(c.key)) out.add(c.key);
    }
    return out;
    // cache.status is included so a re-render after fetch settles refreshes
    // the visible-column derivation against the (possibly populated) cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, allColumns, defaultHidden, cache.status, cache.hiddenByTable.get(tableKey)]);

  const toggleColumn = useCallback((columnKey: string): void => {
    const stored = cache.hiddenByTable.get(tableKey);
    const next = new Set(stored ?? defaultHidden);
    if (next.has(columnKey)) next.delete(columnKey);
    else next.add(columnKey);
    cache.hiddenByTable.set(tableKey, next);
    notify();
    schedulePersist(tableKey);
  }, [tableKey, defaultHidden]);

  const resetToDefault = useCallback((): void => {
    // Reset stores an empty hidden array (defaults-only) rather than deleting
    // the row entirely — keeps the per-table merge semantics on the server
    // simple. Default-hidden columns reapply on the next fetch.
    cache.hiddenByTable.set(tableKey, new Set(defaultHidden));
    notify();
    schedulePersist(tableKey);
  }, [tableKey, defaultHidden]);

  const setAllVisible = useCallback((visible: boolean): void => {
    // visible=true → hidden is empty (every column shows).
    // visible=false → hidden contains every column key (every column hides).
    if (visible) {
      cache.hiddenByTable.set(tableKey, new Set());
    } else {
      const all = new Set<string>();
      for (const c of allColumns) all.add(c.key);
      cache.hiddenByTable.set(tableKey, all);
    }
    notify();
    schedulePersist(tableKey);
  }, [tableKey, allColumns]);

  return {
    visibleColumns,
    toggleColumn,
    setAllVisible,
    resetToDefault,
    isLoading: cache.isLoading,
    error: cache.error,
  };
}

// ── Popover button ───────────────────────────────────────────────────────

const C = {
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  hover: "#1e3a5f",
};

const buttonStyleBase: React.CSSProperties = {
  background: C.card,
  color: C.text,
  border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 1000,
  background: C.card,
  border: `1px solid ${C.cardBdr}`,
  borderRadius: 8,
  boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
  padding: 10,
  minWidth: 220,
  maxHeight: 360,
  overflowY: "auto",
};

export interface TablePrefsButtonProps {
  tableKey: string;
  columns: ColumnDef[];
  visibleColumns: Set<string>;
  onToggle: (columnKey: string) => void;
  onReset: () => void;
  /** Optional bulk toggle. When provided the popover renders a "Select all"
   *  checkbox at the top (tri-state: all visible, none visible, or partial). */
  onSetAll?: (visible: boolean) => void;
  /** Optional CSS class for the trigger button (not the popover). */
  className?: string;
  /** Optional inline style override for the trigger button. */
  style?: React.CSSProperties;
  /** Optional aria-label override. Defaults to "Show/hide columns". */
  ariaLabel?: string;
}

/**
 * Gear-icon button that opens a popover with one checkbox per column,
 * plus a "Reset to default" button. Self-contained: no portal, no external
 * positioning math. Drop next to a panel's search input.
 */
export const TablePrefsButton: React.FC<TablePrefsButtonProps> = ({
  tableKey,
  columns,
  visibleColumns,
  onToggle,
  onReset,
  onSetAll,
  className,
  style,
  ariaLabel = "Show/hide columns",
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerStyle: React.CSSProperties = { ...buttonStyleBase, ...(style ?? {}) };

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", display: "inline-block" }}
      data-table-prefs-key={tableKey}
    >
      <button
        type="button"
        className={className}
        style={triggerStyle}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Columns
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Show columns
          </div>
          {onSetAll && (() => {
            const visibleCount = columns.reduce((n, c) => n + (visibleColumns.has(c.key) ? 1 : 0), 0);
            const allVisible = visibleCount === columns.length;
            const noneVisible = visibleCount === 0;
            return (
              <label
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "4px 6px", borderRadius: 4, cursor: "pointer",
                  fontSize: 12, color: C.text, fontWeight: 600,
                  borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 4, paddingBottom: 6,
                }}
              >
                <input
                  type="checkbox"
                  checked={allVisible}
                  ref={(el) => { if (el) el.indeterminate = !allVisible && !noneVisible; }}
                  onChange={(e) => onSetAll(e.target.checked)}
                  aria-label="Toggle all columns"
                />
                Select all
              </label>
            );
          })()}
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {columns.map((c) => {
              const checked = visibleColumns.has(c.key);
              return (
                <li key={c.key}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 6px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 13,
                      color: C.text,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(c.key)}
                      aria-label={`Toggle ${c.label}`}
                    />
                    {c.label}
                  </label>
                </li>
              );
            })}
          </ul>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => { onReset(); setOpen(false); }}
              style={{ ...buttonStyleBase, fontSize: 11 }}
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Test-only helpers ────────────────────────────────────────────────────
// Exposed so unit tests can reset the module cache between runs without
// resorting to vi.resetModules() (which is brittle with React).

/** @internal */
export function __resetTablePrefsCacheForTests(): void {
  cache.hiddenByTable = new Map();
  cache.status = "unloaded";
  cache.isLoading = false;
  cache.error = null;
  inFlight = null;
  listeners.clear();
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
}

/** @internal — read-only access to the shared cache for tests. */
export function __peekTablePrefsCacheForTests(): {
  hiddenByTable: Record<string, string[]>;
  status: CacheShape["status"];
  error: string | null;
} {
  const out: Record<string, string[]> = {};
  for (const [k, v] of cache.hiddenByTable.entries()) out[k] = Array.from(v);
  return { hiddenByTable: out, status: cache.status, error: cache.error };
}

export default TablePrefsButton;
