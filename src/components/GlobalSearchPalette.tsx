// Tangerine T6-3 — ⌘K global search palette.
// Tangerine T6-4 — close-out polish: recents, entity-type pills, Cmd+N
// shortcuts, result-count footer.
//
// Centred modal opened by useGlobalSearchHotkey. Calls
// GET /api/internal/search?q=<query>&limit=30 (debounced 200ms) and renders
// up to 30 results with keyboard navigation.
//
// Result rows show {entity-type badge} {title} — {subtitle}. Enter (or click)
// navigates to the result's URL — either the API-provided `route_hint` or
// the per-entity-type fallback in `routeFor()` below.
//
// Auth: every browser fetch to /api/internal/* picks up the bearer header
// via the installInternalApiAuth() monkey-patch installed in main.tsx, so
// we don't need to attach Authorization here.
//
// T6-4 additions:
//   - localStorage-backed recents list (capped at 10) shown when input empty.
//     Click a recent → re-runs that query.
//   - Tab cycles result rows (in addition to ↑/↓).
//   - Cmd/Ctrl+Enter opens the highlighted result in a new tab.
//   - Cmd/Ctrl+1..9 jumps directly to result N.
//   - Subtle entity-type filter pills above the result list (client-side
//     filter; hidden when only one entity type appears).
//   - Italic result-count footer ("Showing N of M").

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGlobalSearchHotkey } from "../hooks/useGlobalSearchHotkey";

// ─── Public types ───────────────────────────────────────────────────────────

export type SearchEntityType =
  | "customer"
  | "vendor"
  | "ar_invoice"
  | "ap_invoice"
  | "po"
  | "style"
  | "sku"
  | "gl_account"
  | "case"
  | "sales_rep"
  | "bank_transaction"
  | "brand";

export interface SearchResult {
  entity_type: SearchEntityType | string;
  entity_id: string;
  title: string | null;
  subtitle: string | null;
  rank: number;
  /**
   * Optional API-provided deep-link. If set, prefer it over routeFor().
   * T6-2's view leaves this NULL for most entities — see routeFor() below
   * for the per-entity fallback.
   */
  route_hint?: string | null;
}

// ─── Entity-type badge labels ──────────────────────────────────────────────
// Short label + colour pair shown as a chip on the left of each row. Tuned
// to match the dark Tangerine palette.

const BADGES: Record<string, { label: string; bg: string; fg: string }> = {
  customer:         { label: "customer", bg: "#0e3a5f", fg: "#93c5fd" },
  vendor:           { label: "vendor",   bg: "#3a1d5c", fg: "#c4b5fd" },
  ar_invoice:       { label: "AR",       bg: "#0d4a3a", fg: "#6ee7b7" },
  ap_invoice:       { label: "AP",       bg: "#5c2c0d", fg: "#fdba74" },
  po:               { label: "PO",       bg: "#3a3a0d", fg: "#fde047" },
  style:            { label: "STYLE",    bg: "#5c0d3a", fg: "#f9a8d4" },
  sku:              { label: "SKU",      bg: "#0d3a5c", fg: "#7dd3fc" },
  gl_account:       { label: "GL",       bg: "#3a0d3a", fg: "#e9d5ff" },
  case:             { label: "case",     bg: "#5c0d0d", fg: "#fca5a5" },
  sales_rep:        { label: "rep",      bg: "#0d5c5c", fg: "#67e8f9" },
  bank_transaction: { label: "bank",     bg: "#0d5c2c", fg: "#86efac" },
  brand:            { label: "brand",    bg: "#4a2c0d", fg: "#fcd34d" },
};

const DEFAULT_BADGE = { label: "result", bg: "#334155", fg: "#cbd5e1" };

function badgeFor(entityType: string) {
  return BADGES[entityType] || DEFAULT_BADGE;
}

// Entity-type filter pill labels (one per supported entity type, plus All).
// Order is the order they appear in the filter strip.
const PILL_ORDER: { value: string; label: string }[] = [
  { value: "__all__",          label: "All" },
  { value: "customer",         label: "Customer" },
  { value: "vendor",           label: "Vendor" },
  { value: "ar_invoice",       label: "AR" },
  { value: "ap_invoice",       label: "AP" },
  { value: "po",               label: "PO" },
  { value: "style",            label: "Style" },
  { value: "sku",              label: "SKU" },
  { value: "gl_account",       label: "GL" },
  { value: "case",             label: "Case" },
  { value: "sales_rep",        label: "Rep" },
  { value: "bank_transaction", label: "Bank" },
  { value: "brand",            label: "Brand" },
];

// ─── Recents (localStorage-backed) ──────────────────────────────────────────

export const RECENTS_STORAGE_KEY = "global_search_recents";
export const RECENTS_CAP = 10;

export interface RecentSearch {
  query: string;
  clickedAt: string;          // ISO timestamp
  resultEntityType: string;
  resultTitle: string;
}

/**
 * Read the recents list from localStorage. Returns [] on any failure
 * (missing/corrupt JSON, SSR with no `window`, etc.). Sorted newest-first
 * by the writer; this just deserialises.
 */
export function readRecents(): RecentSearch[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-check each entry; drop anything malformed so a corrupt write
    // doesn't blank the whole feature.
    return parsed.filter((r): r is RecentSearch =>
      r && typeof r === "object"
        && typeof r.query === "string"
        && typeof r.clickedAt === "string"
        && typeof r.resultEntityType === "string"
        && typeof r.resultTitle === "string"
    ).slice(0, RECENTS_CAP);
  } catch {
    return [];
  }
}

/**
 * Prepend a recent entry. Dedupes by `query` (case-insensitive) so the same
 * search bubbling to the top doesn't fill the cap with duplicates. Caps at
 * RECENTS_CAP entries.
 */
export function pushRecent(entry: RecentSearch): RecentSearch[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  const current = readRecents();
  const qNorm = entry.query.trim().toLowerCase();
  const deduped = current.filter((r) => r.query.trim().toLowerCase() !== qNorm);
  const next = [entry, ...deduped].slice(0, RECENTS_CAP);
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private-mode — silently drop. The feature is best-effort.
  }
  return next;
}

// ─── Navigation ─────────────────────────────────────────────────────────────

/**
 * Map an entity_type → a URL the operator can be sent to. The actual panels
 * may not implement `?open=<id>` deep-linking yet — the URL still lands on
 * the right view and the operator can find the row from there.
 *
 * If `route_hint` is set on the result, prefer it (allows the API/view to
 * override the front-end mapping later without a code push).
 */
export function routeFor(result: SearchResult): string {
  if (result.route_hint && typeof result.route_hint === "string" && result.route_hint.trim().length > 0) {
    return result.route_hint;
  }
  const id = encodeURIComponent(result.entity_id);
  switch (result.entity_type) {
    case "customer":         return `/tanda?view=customers&open=${id}`;
    case "vendor":           return `/tanda?view=vendors&open=${id}`;
    case "ar_invoice":       return `/tanda?view=ar-invoices&open=${id}`;
    case "ap_invoice":       return `/tanda?view=ap-invoices&open=${id}`;
    case "po":               return `/tanda?view=tanda-pos&po_id=${id}`;
    case "style":            return `/tanda?view=styles&open=${id}`;
    case "sku":              return `/tanda?view=skus&open=${id}`;
    case "gl_account":       return `/tanda?view=coa&open=${id}`;
    case "case":             return `/tanda?view=cases&open=${id}`;
    case "sales_rep":        return `/tangerine?module=employees`;
    case "bank_transaction": return `/tanda?view=bank-transactions&open=${id}`;
    case "brand":            return `/tangerine?module=pim_catalog`;
    default:                 return `/tanda`;
  }
}

// ─── Palette ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 200;
const MIN_QUERY_LEN = 2;
const RESULT_LIMIT = 30;

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  onToggle: (next: boolean) => void;
  /**
   * Navigation callback. Defaults to `window.location.assign(url)`. Tests
   * override to assert routing without touching jsdom's location.
   */
  navigate?: (url: string) => void;
  /**
   * Optional "open in new tab" callback. Defaults to `window.open(url, "_blank")`.
   * Tests override to assert the new-tab path without touching jsdom.
   */
  openInNewTab?: (url: string) => void;
}

export function GlobalSearchPalette({ open, onClose, onToggle, navigate, openInNewTab }: PaletteProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [pillFilter, setPillFilter] = useState<string>("__all__");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Centralise the global hotkey + Esc handling.
  useGlobalSearchHotkey({ isOpen: open, onToggle, onClose });

  // Reset state when the palette closes so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setQ("");
      setResults([]);
      setHighlight(0);
      setLoading(false);
      setError(null);
      setPillFilter("__all__");
    } else {
      // Refresh recents from storage on each open so we pick up new entries
      // (and any clears from other tabs).
      setRecents(readRecents());
    }
  }, [open]);

  // Autofocus the input whenever the palette opens.
  useEffect(() => {
    if (open && inputRef.current) {
      // setTimeout 0 — give the modal a paint tick before grabbing focus,
      // matches the behaviour of native dialogs.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const url = `/api/internal/search?q=${encodeURIComponent(trimmed)}&limit=${RESULT_LIMIT}`;
        const res = await fetch(url, { method: "GET" });
        if (cancelled) return;
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            if (j && typeof j.error === "string") msg = j.error;
          } catch { /* ignore — keep HTTP fallback */ }
          throw new Error(msg);
        }
        const json = await res.json();
        if (cancelled) return;
        const rows: SearchResult[] = Array.isArray(json?.results) ? json.results : [];
        setResults(rows);
        setHighlight(0);
        setPillFilter("__all__");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, open]);

  // ── Derived: pill counts + filtered display rows ─────────────────────────

  // Counts of each entity_type present in the current result set. Used to
  // (a) decide whether to render pills at all (>1 distinct type) and
  // (b) hide pills for entity types not present in this result set.
  const entityTypeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of results) {
      m[r.entity_type] = (m[r.entity_type] || 0) + 1;
    }
    return m;
  }, [results]);

  const distinctEntityTypeCount = Object.keys(entityTypeCounts).length;
  const showPills = distinctEntityTypeCount > 1;

  // Filter rows client-side based on the selected pill. "__all__" is no-op.
  const displayRows = useMemo(() => {
    if (pillFilter === "__all__") return results;
    return results.filter((r) => r.entity_type === pillFilter);
  }, [results, pillFilter]);

  // Reset highlight when the filter shrinks the visible list past it.
  useEffect(() => {
    if (highlight >= displayRows.length) {
      setHighlight(0);
    }
  }, [displayRows.length, highlight]);

  // ── Navigation helpers ───────────────────────────────────────────────────

  const doNavigate = useCallback((url: string) => {
    if (navigate) navigate(url);
    else if (typeof window !== "undefined") window.location.assign(url);
  }, [navigate]);

  const doOpenInNewTab = useCallback((url: string) => {
    if (openInNewTab) openInNewTab(url);
    else if (typeof window !== "undefined") window.open(url, "_blank");
  }, [openInNewTab]);

  // Record a recent-search entry; called for click + Enter + new-tab paths
  // so all "I picked this row" actions show up in the recents list.
  const recordRecent = useCallback((r: SearchResult) => {
    const trimmed = q.trim();
    if (trimmed.length < MIN_QUERY_LEN) return;
    const next = pushRecent({
      query: trimmed,
      clickedAt: new Date().toISOString(),
      resultEntityType: r.entity_type,
      resultTitle: r.title || r.entity_id,
    });
    setRecents(next);
  }, [q]);

  const onPickResult = useCallback((r: SearchResult) => {
    recordRecent(r);
    onClose();
    doNavigate(routeFor(r));
  }, [onClose, doNavigate, recordRecent]);

  const onPickResultNewTab = useCallback((r: SearchResult) => {
    recordRecent(r);
    doOpenInNewTab(routeFor(r));
    // Intentionally don't close — power users open multiple tabs.
  }, [doOpenInNewTab, recordRecent]);

  // Click a recent → re-run the query (it fills the input; debounced fetch
  // fires on next tick).
  const onPickRecent = useCallback((entry: RecentSearch) => {
    setQ(entry.query);
    // Focus the input so the next keystroke goes there.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Keyboard nav inside the input. ↑/↓/Tab cycle, Enter picks,
  // Cmd+Enter opens new tab, Cmd+1..9 jumps directly to row N,
  // Esc is handled by useGlobalSearchHotkey.
  const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const rowCount = displayRows.length;

    // Cmd/Ctrl+1..9 — jump directly to row N (1-indexed for the user, 0 in
    // the array). Trigger BEFORE the generic Cmd handlers so the digit isn't
    // gobbled by a text-input shortcut.
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < rowCount) {
        e.preventDefault();
        const picked = displayRows[idx];
        if (picked) onPickResult(picked);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (rowCount === 0 ? 0 : (h + 1) % rowCount));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (rowCount === 0 ? 0 : (h - 1 + rowCount) % rowCount));
    } else if (e.key === "Tab") {
      // Tab / Shift-Tab cycle rows. We override the browser's default focus
      // movement so Tab feels like a second arrow-down to power users.
      if (rowCount === 0) return;
      e.preventDefault();
      if (e.shiftKey) {
        setHighlight((h) => (h - 1 + rowCount) % rowCount);
      } else {
        setHighlight((h) => (h + 1) % rowCount);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = displayRows[highlight];
      if (!picked) return;
      if (e.metaKey || e.ctrlKey) {
        onPickResultNewTab(picked);
      } else {
        onPickResult(picked);
      }
    }
  }, [displayRows, highlight, onPickResult, onPickResultNewTab]);

  // Keep highlighted row scrolled into view when ↑/↓ pushes it off-screen.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-result-index="${highlight}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlight]);

  const trimmed = q.trim();
  const isEmptyInput = trimmed.length < MIN_QUERY_LEN;
  const showRecents = isEmptyInput && recents.length > 0 && !error;
  const showEmptyHint = isEmptyInput && recents.length === 0 && !error;
  const showNoResults = !loading && !error && trimmed.length >= MIN_QUERY_LEN && results.length === 0;

  // Show "0 of M (filter hides all)" if the pill filter has zeroed the view.
  const showFilteredEmpty = !loading && !error && results.length > 0 && displayRows.length === 0;

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      data-testid="global-search-palette"
      onMouseDown={(e) => {
        // Backdrop click — only the outermost div fires here because the
        // panel below stops propagation.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 2000,
        paddingTop: "20vh",
        paddingLeft: 16,
        paddingRight: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 600,
          background: "#1E293B",
          border: "1px solid #334155",
          borderRadius: 14,
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "70vh",
        }}
      >
        {/* Input row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid #334155",
            background: "#0F172A",
          }}
        >
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search customers, vendors, invoices, POs, styles, SKUs…"
            aria-label="Search query"
            data-testid="global-search-input"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#F1F5F9",
              fontSize: 16,
              fontFamily: "inherit",
            }}
          />
          {loading && (
            <span
              data-testid="global-search-spinner"
              aria-label="Loading"
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: "2px solid #475569",
                borderTopColor: "#cbd5e1",
                animation: "globalSearchSpin 0.8s linear infinite",
                flexShrink: 0,
              }}
            />
          )}
          <span style={{ fontSize: 10, color: "#64748B", fontWeight: 600, letterSpacing: "0.05em" }}>ESC</span>
        </div>

        {/* Inline error banner */}
        {error && (
          <div
            data-testid="global-search-error"
            role="alert"
            style={{
              padding: "8px 18px",
              background: "#3a0d0d",
              color: "#fca5a5",
              fontSize: 12,
              borderBottom: "1px solid #5c0d0d",
            }}
          >
            Search failed: {error}
          </div>
        )}

        {/* Entity-type filter pills (only when we have ≥2 distinct types) */}
        {showPills && (
          <div
            data-testid="global-search-pills"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "8px 18px",
              borderBottom: "1px solid #334155",
              background: "#0F172A",
            }}
          >
            {PILL_ORDER.map((p) => {
              // Hide pills for entity types not in the current result set
              // (keep "All" always visible).
              if (p.value !== "__all__" && !entityTypeCounts[p.value]) return null;
              const active = pillFilter === p.value;
              const count = p.value === "__all__" ? results.length : (entityTypeCounts[p.value] || 0);
              return (
                <button
                  key={p.value}
                  type="button"
                  data-testid={`global-search-pill-${p.value}`}
                  onClick={() => setPillFilter(p.value)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: active ? "1px solid #3B82F6" : "1px solid #334155",
                    background: active ? "#0e3a5f" : "transparent",
                    color: active ? "#93c5fd" : "#94A3B8",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {p.label}
                  <span style={{ marginLeft: 6, opacity: 0.7 }}>{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Empty / recents / loading / no-results / results body */}
        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            flex: 1,
            background: "#1E293B",
          }}
        >
          {showEmptyHint && (
            <div
              data-testid="global-search-empty"
              style={{
                padding: "20px 22px",
                color: "#94A3B8",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              Type to search across customers, vendors, invoices, POs, styles, SKUs, brands, GL accounts, cases, sales reps, bank transactions.
            </div>
          )}

          {showRecents && (
            <div data-testid="global-search-recents">
              <div
                style={{
                  padding: "10px 22px 6px",
                  color: "#64748B",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Recent searches
              </div>
              {recents.map((r, i) => {
                const b = badgeFor(r.resultEntityType);
                return (
                  <div
                    key={`recent-${i}`}
                    data-testid={`global-search-recent-${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onPickRecent(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPickRecent(r);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 22px",
                      cursor: "pointer",
                      color: "#CBD5E1",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: "monospace" }}>
                      &quot;{r.query}&quot;
                    </span>
                    <span style={{ color: "#475569", fontSize: 12 }}>—</span>
                    <span style={{ color: "#94A3B8", fontSize: 12 }}>last opened:</span>
                    <span
                      style={{
                        padding: "1px 6px",
                        borderRadius: 3,
                        background: b.bg,
                        color: b.fg,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      {b.label}
                    </span>
                    <span
                      style={{
                        color: "#CBD5E1",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      &quot;{r.resultTitle}&quot;
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {showNoResults && (
            <div
              data-testid="global-search-no-results"
              style={{
                padding: "20px 22px",
                color: "#94A3B8",
                fontSize: 13,
              }}
            >
              No results for &quot;{trimmed}&quot;.
            </div>
          )}

          {showFilteredEmpty && (
            <div
              data-testid="global-search-filtered-empty"
              style={{
                padding: "20px 22px",
                color: "#94A3B8",
                fontSize: 13,
              }}
            >
              No results match the selected filter.
            </div>
          )}

          {displayRows.map((r, i) => {
            const b = badgeFor(r.entity_type);
            const isActive = i === highlight;
            return (
              <div
                key={`${r.entity_type}:${r.entity_id}:${i}`}
                data-result-index={i}
                data-testid={`global-search-result-${i}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlight(i)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) onPickResultNewTab(r);
                  else onPickResult(r);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 18px",
                  cursor: "pointer",
                  background: isActive ? "#0e3a5f" : "transparent",
                  borderLeft: isActive ? "3px solid #3B82F6" : "3px solid transparent",
                  transition: "background 0.08s",
                }}
              >
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: b.bg,
                    color: b.fg,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    flexShrink: 0,
                    minWidth: 56,
                    textAlign: "center",
                  }}
                >
                  {b.label}
                </span>
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#F1F5F9",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.title || r.entity_id}
                  </div>
                  {r.subtitle && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "#94A3B8",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        marginTop: 1,
                      }}
                    >
                      {r.subtitle}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Result count footer — italic, only when we have a result set */}
        {results.length > 0 && !error && (
          <div
            data-testid="global-search-count"
            style={{
              padding: "6px 18px",
              borderTop: "1px solid #334155",
              background: "#0F172A",
              color: "#64748B",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            Showing {displayRows.length} of {results.length} (limit {RESULT_LIMIT})
          </div>
        )}

        {/* Footer hint */}
        <div
          style={{
            padding: "8px 18px",
            borderTop: "1px solid #334155",
            background: "#0F172A",
            display: "flex",
            justifyContent: "space-between",
            color: "#64748B",
            fontSize: 11,
          }}
        >
          <span>↑↓/Tab navigate · ↵ open · ⌘↵ new tab · ⌘1-9 jump · Esc close</span>
          <span>⌘K / Ctrl-K</span>
        </div>
      </div>

      <style>{`@keyframes globalSearchSpin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}`}</style>
    </div>
  );
}

// Convenience self-hosted wrapper — manages its own open state and exposes
// onOpen so consumers can wire a trigger button. The palette + hook are
// always mounted, so ⌘K works app-wide even if the trigger isn't visible.
export function GlobalSearchPaletteAuto() {
  const [open, setOpen] = useState(false);
  return (
    <GlobalSearchPalette
      open={open}
      onClose={() => setOpen(false)}
      onToggle={(next) => setOpen(next)}
    />
  );
}

export default GlobalSearchPalette;
