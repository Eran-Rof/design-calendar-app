// Tangerine — Always-visible universal search bar (top bar, far left).
//
// A persistent search input that lives in the Tangerine top bar (rendered on
// every ERP module page). As-you-type (debounced 280ms) it calls
//   GET /api/internal/global-search?q=<term>
// which searches the whole database across the major business entities and
// returns results grouped by entity. Results render in a dark dropdown grouped
// by entity with group headers; keyboard ↑/↓ move the highlight, Enter opens
// the highlighted record, Esc closes.
//
// Navigation reuses the app's URL contract (same as scorecardDrill.drillToModule):
// set ?m=<moduleKey> plus a ?q=<code> seed, pushState, then dispatch a synthetic
// popstate so Tangerine swaps the panel WITHOUT a reload (same-origin, no
// noopener — keeps the session). The target panel reads ?q= on mount and filters
// to the record.
//
// Auth: every browser fetch to /api/internal/* picks up the bearer header via
// installInternalApiAuth() (main.tsx), so no Authorization handling here.
//
// This is the single global-search UI for the Tangerine shell. The old ⌘K
// GlobalSearchPalette (full-text modal) was retired here; ⌘K / Ctrl-K now FOCUS
// this always-visible bar (muscle memory preserved). The bar uses substring
// (ILIKE) matching for "any term".

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// True on macOS-family platforms — used only to render the right hotkey glyph
// in the placeholder hint (⌘K vs Ctrl K). Guarded for SSR / jsdom.
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

// ─── Types (mirror the /api/internal/global-search response) ────────────────

export interface GlobalSearchItem {
  entity_type: string;
  code: string | null;
  label: string | null;
  sublabel: string | null;
  // Either a Tangerine module hop ({module, params}) OR a full same-origin
  // href (used for entities that live in a different SPA shell, e.g. tanda_pos
  // opens in the PO WIP app at /tanda).
  nav: { module?: string; params?: Record<string, string>; href?: string };
}
export interface GlobalSearchGroup {
  key: string;
  label: string;
  items: GlobalSearchItem[];
}
interface GlobalSearchResponse {
  q: string;
  groups: GlobalSearchGroup[];
  total: number;
}

const DEBOUNCE_MS = 280;
const MIN_QUERY_LEN = 2;

// ─── Navigation ─────────────────────────────────────────────────────────────
// Mirrors scorecardDrill.drillToModule but accepts ANY module key + arbitrary
// seed params. Same-origin pushState + synthetic popstate → no reload, session
// preserved, no noopener.
export function navigateToResult(item: GlobalSearchItem, win: Window = window): void {
  if (typeof win === "undefined" || !win.location) return;
  // Full same-origin href (e.g. tanda_pos → PO WIP app). No noopener — a
  // same-origin assign preserves the session.
  if (item.nav.href) {
    win.location.assign(item.nav.href);
    return;
  }
  if (!item.nav.module) return;
  const url = new URL(win.location.href);
  // Clear stale drill/filter params from a previous hop so panels don't get
  // cross-wired.
  for (const k of ["vendor", "customer", "q", "je", "so", "open", "style", "style_id"]) {
    url.searchParams.delete(k);
  }
  url.searchParams.set("m", item.nav.module);
  const params = item.nav.params || {};
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  win.history.pushState({ module: item.nav.module }, "", url.toString());
  // Tangerine's popstate handler re-reads ?m= and mounts the target panel.
  const Ctor = typeof PopStateEvent !== "undefined" ? PopStateEvent : Event;
  win.dispatchEvent(new Ctor("popstate"));
}

// ─── Substring highlight ────────────────────────────────────────────────────
// Split `text` around the first case-insensitive occurrence of `term` and wrap
// the match. Exported for unit testing.
export function highlightParts(text: string, term: string): Array<{ t: string; hit: boolean }> {
  if (!text) return [];
  const q = term.trim();
  if (q.length < 1) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push({ t: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + needle.length), hit: true });
    i = idx + needle.length;
  }
  return parts;
}

function Highlighted({ text, term }: { text: string; term: string }) {
  const parts = useMemo(() => highlightParts(text, term), [text, term]);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            style={{ background: "transparent", color: "#93c5fd", fontWeight: 700, padding: 0 }}
          >
            {p.t}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.t}</React.Fragment>
        ),
      )}
    </>
  );
}

// Flatten groups into a single ordered list so ↑/↓ can traverse across groups.
export function flattenGroups(groups: GlobalSearchGroup[]): GlobalSearchItem[] {
  const out: GlobalSearchItem[] = [];
  for (const g of groups) for (const it of g.items) out.push(it);
  return out;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface TopbarGlobalSearchProps {
  /** Override the fetcher (tests). Defaults to window.fetch against the API. */
  fetcher?: (q: string, signal: AbortSignal) => Promise<GlobalSearchResponse>;
  /** Override navigation (tests). */
  onNavigate?: (item: GlobalSearchItem) => void;
}

async function defaultFetcher(q: string, signal: AbortSignal): Promise<GlobalSearchResponse> {
  const res = await fetch(`/api/internal/global-search?q=${encodeURIComponent(q)}`, {
    method: "GET",
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* keep HTTP fallback */
    }
    throw new Error(msg);
  }
  const json = await res.json();
  return {
    q: typeof json?.q === "string" ? json.q : q,
    groups: Array.isArray(json?.groups) ? json.groups : [],
    total: typeof json?.total === "number" ? json.total : 0,
  };
}

export default function TopbarGlobalSearch({ fetcher, onNavigate }: TopbarGlobalSearchProps) {
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<GlobalSearchGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const trimmed = q.trim();
  const hotkeyHint = useMemo(() => (isMacPlatform() ? "⌘K" : "Ctrl K"), []);

  // Debounced fetch.
  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LEN) {
      setGroups([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const run = fetcher || defaultFetcher;
        const data = await run(trimmed, controller.signal);
        if (controller.signal.aborted) return;
        setGroups(data.groups);
        setHighlight(0);
        setOpen(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setGroups([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [trimmed, fetcher]);

  // Close on outside click.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  // App-shell-level ⌘K / Ctrl-K → focus this bar. The bar is mounted exactly
  // once in the Tangerine top bar, so a single window listener here IS the
  // shell-level handler (no per-panel duplication). preventDefault stops the
  // browser's location-bar focus shortcut. This preserves the muscle memory of
  // the retired ⌘K palette while routing to the unified search.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep highlight in range as the list changes.
  useEffect(() => {
    if (highlight >= flat.length) setHighlight(0);
  }, [flat.length, highlight]);

  // Scroll highlighted row into view.
  useEffect(() => {
    if (!panelRef.current) return;
    const el = panelRef.current.querySelector<HTMLElement>(`[data-gs-index="${highlight}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const doNavigate = useCallback(
    (item: GlobalSearchItem) => {
      setOpen(false);
      setQ("");
      setGroups([]);
      if (onNavigate) onNavigate(item);
      else navigateToResult(item);
    },
    [onNavigate],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        // Esc clears the query, closes the panel, and blurs the input.
        setOpen(false);
        setQ("");
        setGroups([]);
        (e.target as HTMLInputElement).blur();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open && flat.length > 0) setOpen(true);
        setHighlight((h) => (flat.length === 0 ? 0 : (h + 1) % flat.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (flat.length === 0 ? 0 : (h - 1 + flat.length) % flat.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = flat[highlight];
        if (picked) doNavigate(picked);
      }
    },
    [flat, highlight, open, doNavigate],
  );

  const showPanel =
    open && trimmed.length >= MIN_QUERY_LEN && (loading || error !== null || flat.length >= 0);
  const showNoResults = !loading && !error && trimmed.length >= MIN_QUERY_LEN && flat.length === 0;

  // Running index across groups so ↑/↓ maps to the flat list.
  let runningIndex = -1;

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", flex: "1 1 auto", minWidth: 0, maxWidth: 360, marginRight: "auto" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "#0F172A",
          border: `1px solid ${open && flat.length > 0 ? "#3B82F6" : "#334155"}`,
          borderRadius: 8,
          padding: "0 8px",
          height: 28,
        }}
      >
        <span aria-hidden style={{ color: "#64748B", fontSize: 13, flexShrink: 0 }}>⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (flat.length > 0) setOpen(true);
          }}
          placeholder="Search everything…"
          aria-label="Search the whole database"
          data-testid="topbar-global-search-input"
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#F1F5F9",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        />
        {!loading && q.length === 0 && (
          <span
            aria-hidden
            data-testid="topbar-global-search-hotkey-hint"
            style={{
              flexShrink: 0,
              padding: "1px 5px",
              borderRadius: 4,
              border: "1px solid #334155",
              background: "#1E293B",
              color: "#64748B",
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: "0.04em",
              lineHeight: 1.4,
              whiteSpace: "nowrap",
            }}
          >
            {hotkeyHint}
          </span>
        )}
        {loading && (
          <span
            data-testid="topbar-global-search-spinner"
            aria-label="Loading"
            style={{
              width: 11,
              height: 11,
              borderRadius: "50%",
              border: "2px solid #475569",
              borderTopColor: "#cbd5e1",
              animation: "topbarGsSpin 0.8s linear infinite",
              flexShrink: 0,
            }}
          />
        )}
        {!loading && q.length > 0 && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQ("");
              setGroups([]);
              setOpen(false);
              inputRef.current?.focus();
            }}
            style={{
              background: "none",
              border: "none",
              color: "#64748B",
              cursor: "pointer",
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {showPanel && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Search results"
          data-testid="topbar-global-search-panel"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            width: "min(440px, 90vw)",
            maxHeight: "70vh",
            overflowY: "auto",
            background: "#1E293B",
            border: "1px solid #334155",
            borderRadius: 10,
            boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
            zIndex: 300,
          }}
        >
          {error && (
            <div
              role="alert"
              data-testid="topbar-global-search-error"
              style={{ padding: "10px 14px", color: "#fca5a5", fontSize: 12, background: "#3a0d0d" }}
            >
              Search failed: {error}
            </div>
          )}

          {showNoResults && !error && (
            <div
              data-testid="topbar-global-search-empty"
              style={{ padding: "16px 14px", color: "#94A3B8", fontSize: 13 }}
            >
              No matches for &quot;{trimmed}&quot;.
            </div>
          )}

          {!error &&
            groups.map((g) => (
              <div key={g.key} data-testid={`topbar-global-search-group-${g.key}`}>
                <div
                  style={{
                    padding: "8px 14px 4px",
                    color: "#64748B",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    position: "sticky",
                    top: 0,
                    background: "#1E293B",
                  }}
                >
                  {g.label}
                  <span style={{ marginLeft: 6, opacity: 0.6 }}>{g.items.length}</span>
                </div>
                {g.items.map((it) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  const active = idx === highlight;
                  return (
                    <div
                      key={`${it.entity_type}:${it.code}:${idx}`}
                      role="option"
                      aria-selected={active}
                      data-gs-index={idx}
                      data-testid={`topbar-global-search-result-${idx}`}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => doNavigate(it)}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 10,
                        padding: "7px 14px",
                        cursor: "pointer",
                        background: active ? "rgba(59,130,246,0.16)" : "transparent",
                        borderLeft: active ? "3px solid #3B82F6" : "3px solid transparent",
                      }}
                    >
                      <span
                        style={{
                          color: "#3B82F6",
                          fontSize: 12,
                          fontWeight: 600,
                          fontFamily: "monospace",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          maxWidth: 140,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        <Highlighted text={it.code || ""} term={trimmed} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          color: "#F1F5F9",
                          fontSize: 12.5,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        <Highlighted text={it.label || ""} term={trimmed} />
                        {it.sublabel && (
                          <span style={{ color: "#94A3B8", marginLeft: 8, fontSize: 11 }}>
                            {it.sublabel}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      )}

      <style>{`@keyframes topbarGsSpin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}`}</style>
    </div>
  );
}
