// Tangerine T6-3 — ⌘K global search palette.
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
  | "bank_transaction";

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
};

const DEFAULT_BADGE = { label: "result", bg: "#334155", fg: "#cbd5e1" };

function badgeFor(entityType: string) {
  return BADGES[entityType] || DEFAULT_BADGE;
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
    case "sales_rep":        return `/tanda?view=sales-reps&open=${id}`;
    case "bank_transaction": return `/tanda?view=bank-transactions&open=${id}`;
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
}

export function GlobalSearchPalette({ open, onClose, onToggle, navigate }: PaletteProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const doNavigate = useCallback((url: string) => {
    if (navigate) navigate(url);
    else if (typeof window !== "undefined") window.location.assign(url);
  }, [navigate]);

  const onPickResult = useCallback((r: SearchResult) => {
    onClose();
    doNavigate(routeFor(r));
  }, [onClose, doNavigate]);

  // Keyboard nav inside the input. ↑/↓ scroll highlighted row, Enter picks,
  // Esc is handled by useGlobalSearchHotkey.
  const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (results.length === 0 ? 0 : (h - 1 + results.length) % results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = results[highlight];
      if (picked) onPickResult(picked);
    }
  }, [results, highlight, onPickResult]);

  // Keep highlighted row scrolled into view when ↑/↓ pushes it off-screen.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-result-index="${highlight}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlight]);

  const trimmed = q.trim();
  const showEmptyHint = trimmed.length < MIN_QUERY_LEN;
  const showNoResults = !loading && !error && trimmed.length >= MIN_QUERY_LEN && results.length === 0;

  const memoizedRows = useMemo(() => results, [results]);

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
          <span style={{ fontSize: 18, color: "#94A3B8" }} aria-hidden="true">🔍</span>
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

        {/* Empty / loading / no-results / results body */}
        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            flex: 1,
            background: "#1E293B",
          }}
        >
          {showEmptyHint && !error && (
            <div
              data-testid="global-search-empty"
              style={{
                padding: "20px 22px",
                color: "#94A3B8",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              Type to search across customers, vendors, invoices, POs, styles, SKUs, GL accounts, cases, sales reps, bank transactions.
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

          {memoizedRows.map((r, i) => {
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
                onClick={() => onPickResult(r)}
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
          <span>↑↓ navigate · ↵ open · Esc close</span>
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
