// Cross-cutter T4-7 — Favorites strip (operator asks #2 + #3).
//
// REDESIGN (2026-05-30) of the original T4-3 right-side drawer.
//
// Operator ask #2: "Move favorites drawer from right side of screen open
// below the main menu, each favorite opening under its main menu
// dropdown, one window across the screen for clean even look."
//
// Operator ask #3: "I don't see how the user selects to favorite any
// open view menu selection." → a discoverable in-strip "Star this view"
// pill that toggles favorite-status for the currently-displayed panel.
//
// Layout:
//   • Fixed bar across the full viewport width, anchored just below the
//     app menu (top: 56). Background matches Tanda slate chrome so it
//     reads as a continuation of the menu, not a competing surface.
//   • Body is laid out as evenly-sized columns — one per nav group
//     present in the operator's favorites (Vendors / Operations / etc).
//     Each column has the group label as a quiet header and the
//     starred items stacked underneath. Empty groups don't render —
//     non-empty groups expand to fill the width.
//   • Each item is a click-to-navigate button + an × remove control.
//     If the visible label list overflows the column's height (rare),
//     the column scrolls VERTICALLY within itself so the strip itself
//     stays one row high.
//   • Header row holds the "Favorites" title, the count, a "Star this
//     view" pill bound to whatever menu_key the current URL resolves to
//     via the per-app viewToMenuKey helpers, and the collapse chevron.
//   • Collapsed state persists to user_preferences via
//     usePersonalization().setDrawerCollapsed(). When collapsed the
//     strip becomes a single thin pill at the top-right of the menu bar
//     so the operator can re-open it without going into Settings.
//   • A small inline toast renderer (subscribes to favoritesToast bus)
//     surfaces "Added to favorites" / "Removed from favorites" feedback.
//
// Style: matches Tanda's dark-slate chrome (used app-wide) via inline
// styles since the repo doesn't use Tailwind. Conventions cribbed from
// src/tanda/styles.ts.

import { useEffect, useMemo, useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";
import { MENU_KEY_BY_KEY, MENU_KEYS, type MenuKey } from "../lib/menuKeys";
import {
  emitFavoritesToast,
  subscribeFavoritesToasts,
  type FavoritesToast,
} from "./favoritesToast";
import { tandaViewToMenuKey } from "../lib/tandaViewToMenuKey";
import { atsViewToMenuKey } from "../lib/atsViewToMenuKey";
import { dcViewToMenuKey } from "../lib/dcViewToMenuKey";
import { gs1ViewToMenuKey } from "../lib/gs1ViewToMenuKey";
import { techpackViewToMenuKey } from "../lib/techpackViewToMenuKey";

// Tanda-ish slate palette
const C = {
  panel:    "#1E293B",
  panelHi:  "#334155",
  border:   "#334155",
  text:     "#F1F5F9",
  textDim:  "#94A3B8",
  textSub:  "#CBD5E1",
  accent:   "#3B82F6",
  star:     "#F59E0B",
  remove:   "#EF4444",
  ok:       "#22C55E",
};

// Strip sits just below the app menu bar. 56 px matches the visible
// height of every app's <nav> banner (see TandA.tsx S.navBtn padding).
const STRIP_TOP = 56;

// ── Current-view detection ────────────────────────────────────────────────
//
// All five apps drive their active panel from a URL query string (view=,
// tab=, or report=). The map below tells us which query key each app
// uses so the strip can derive the current menu_key without React
// router context. We intentionally read window.location directly —
// the app uses a mix of routers and the strip mounts as a global
// component, so the URL is the only common contract.

interface CurrentView {
  menuKey: string | null;
  /** Cosmetic label used in the "Star <label>" pill. */
  label: string;
}

export function detectCurrentView(): CurrentView {
  if (typeof window === "undefined") return { menuKey: null, label: "this view" };
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  let menuKey: string | null = null;

  if (path.startsWith("/tanda")) {
    const view = params.get("view") || "dashboard";
    menuKey = tandaViewToMenuKey(view);
  } else if (path.startsWith("/ats")) {
    // ATS uses ?view= for grid pivots AND ?report= for the reports menu.
    const report = params.get("report");
    if (report) {
      const candidate = `ats/reports/${report}`;
      menuKey = MENU_KEY_BY_KEY[candidate] ? candidate : null;
    } else {
      menuKey = atsViewToMenuKey(params.get("view") || "ats");
    }
  } else if (path.startsWith("/gs1")) {
    menuKey = gs1ViewToMenuKey(params.get("tab") || "company");
  } else if (path.startsWith("/techpack")) {
    menuKey = techpackViewToMenuKey(params.get("view") || "dashboard");
  } else if (path.startsWith("/design") || path === "/") {
    menuKey = dcViewToMenuKey(params.get("view") || "dashboard");
  }

  const label = menuKey && MENU_KEY_BY_KEY[menuKey]
    ? MENU_KEY_BY_KEY[menuKey].label
    : "this view";
  return { menuKey, label };
}

function useCurrentView(): CurrentView {
  const [cv, setCv] = useState<CurrentView>(() => detectCurrentView());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setCv(detectCurrentView());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    // Many panels swap via setState without a real URL change; we poll
    // at a low rate so the pill catches view changes that don't go
    // through history. 750 ms is fast enough to feel reactive without
    // burning a meaningful amount of CPU.
    const t = window.setInterval(update, 750);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.clearInterval(t);
    };
  }, []);
  return cv;
}

// ── Group ordering ────────────────────────────────────────────────────────
//
// We render one column per group present in the operator's favorites,
// in REGISTRY order. That keeps the strip layout stable as the user
// adds/removes items — favoriting a Vendors panel and then a Sourcing
// panel always produces Vendors-left-of-Sourcing, never the order of
// the click. `null` group items (loose top-level items without a group
// label) get bucketed into a "Pinned" column at the far left.

const REGISTRY_GROUP_ORDER: string[] = (() => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of MENU_KEYS) {
    const g = m.group ?? "Pinned";
    if (!seen.has(g)) { seen.add(g); order.push(g); }
  }
  return order;
})();

function groupForKey(k: string): string {
  const m: MenuKey | undefined = MENU_KEY_BY_KEY[k];
  return m?.group ?? "Pinned";
}

interface GroupedFavorite {
  group: string;
  items: string[];
}

function groupFavorites(keys: string[]): GroupedFavorite[] {
  const byGroup = new Map<string, string[]>();
  for (const k of keys) {
    const g = groupForKey(k);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(k);
  }
  return REGISTRY_GROUP_ORDER
    .filter((g) => byGroup.has(g))
    .map((g) => ({ group: g, items: byGroup.get(g)! }));
}

// ── Inline toast renderer ─────────────────────────────────────────────────

function FavoritesToastStack(): JSX.Element | null {
  const [toasts, setToasts] = useState<FavoritesToast[]>([]);

  useEffect(() => {
    const unsub = subscribeFavoritesToasts((t) => {
      setToasts((cur) => [...cur, t]);
      // Auto-dismiss after 2.4 s.
      window.setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.id !== t.id));
      }, 2400);
    });
    return () => unsub();
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      data-testid="favorites-toast-stack"
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            background: t.kind === "error" ? C.remove : C.panel,
            color: t.kind === "error" ? "#fff" : C.text,
            border: `1px solid ${t.kind === "error" ? C.remove : C.border}`,
            padding: "8px 14px",
            borderRadius: 6,
            boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: t.kind === "added" ? C.star : t.kind === "removed" ? C.textDim : "#fff" }}>
            {t.kind === "added" ? "★" : t.kind === "removed" ? "☆" : "!"}
          </span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export default function FavoritesDrawer(): JSX.Element {
  const {
    favorites,
    toggleFavorite,
    drawerCollapsed,
    setDrawerCollapsed,
    loading,
  } = usePersonalization();
  const currentView = useCurrentView();

  const grouped = useMemo(() => groupFavorites(favorites), [favorites]);
  const currentIsFav = currentView.menuKey ? favorites.includes(currentView.menuKey) : false;

  // Push panel content below the strip when expanded so it does NOT overlay
  // the page (e.g. Style Master's search bar). The menu and the strip are
  // both position:fixed; adding body padding-top shifts ALL document content
  // down without affecting the fixed overlays.
  //   - Collapsed: padding 0 (existing behavior, content under the menu)
  //   - Expanded: padding 108 (56px menu + ~52px strip) so content starts
  //     just below the strip's bottom edge.
  // The 108px figure mirrors STRIP_TOP (56) + strip-row height (~52).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.paddingTop;
    document.body.style.paddingTop = drawerCollapsed ? "" : "108px";
    return () => { document.body.style.paddingTop = prev; };
  }, [drawerCollapsed]);

  function navigate(route: string): void {
    if (typeof window === "undefined") return;
    window.location.href = route;
  }

  async function setCollapsedSafe(next: boolean): Promise<void> {
    try { await setDrawerCollapsed(next); } catch { /* hook rolled back; localStorage still tracks */ }
  }

  async function removeKey(menuKey: string): Promise<void> {
    const meta = MENU_KEY_BY_KEY[menuKey];
    const label = meta?.label ?? menuKey;
    try {
      await toggleFavorite(menuKey);
      emitFavoritesToast("removed", `Removed "${label}" from favorites`);
    } catch {
      emitFavoritesToast("error", `Could not remove "${label}" — try again`);
    }
  }

  async function toggleCurrent(): Promise<void> {
    if (!currentView.menuKey) return;
    const wasFav = favorites.includes(currentView.menuKey);
    try {
      await toggleFavorite(currentView.menuKey);
      emitFavoritesToast(
        wasFav ? "removed" : "added",
        wasFav
          ? `Removed "${currentView.label}" from favorites`
          : `Added "${currentView.label}" to favorites`,
      );
    } catch {
      emitFavoritesToast("error", `Could not update favorites — try again`);
    }
  }

  // Collapsed: thin pill at the top-right of the menu bar.
  if (drawerCollapsed) {
    return (
      <>
        <div
          data-testid="favorites-strip-collapsed"
          style={{
            position: "fixed",
            top: STRIP_TOP - 28,
            right: 8,
            zIndex: 49,
          }}
        >
          <button
            type="button"
            onClick={() => void setCollapsedSafe(false)}
            aria-label="Open favorites strip"
            title="Open favorites"
            style={{
              background: C.panel,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
            }}
          >
            <span style={{ color: C.star }}>★</span>
            <span>Favorites{favorites.length > 0 ? ` (${favorites.length})` : ""}</span>
            <span aria-hidden style={{ color: C.textDim }}>▾</span>
          </button>
        </div>
        <FavoritesToastStack />
      </>
    );
  }

  return (
    <>
      <div
        data-testid="favorites-strip"
        role="complementary"
        aria-label="Favorites"
        style={{
          position: "fixed",
          top: STRIP_TOP,
          left: 0,
          right: 0,
          zIndex: 49,
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          color: C.text,
          fontFamily: "inherit",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        }}
      >
        {/* Header row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderBottom: `1px solid ${C.border}`,
            background: C.panelHi,
            gap: 12,
            minHeight: 28,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.star }}>★</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                color: C.text,
              }}
            >
              Favorites
            </span>
            {favorites.length > 0 && (
              <span style={{ fontSize: 10, color: C.textDim }}>({favorites.length})</span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {currentView.menuKey ? (
              <button
                type="button"
                data-testid="favorites-strip-current-view-toggle"
                onClick={() => void toggleCurrent()}
                aria-pressed={currentIsFav}
                aria-label={
                  currentIsFav
                    ? `Remove ${currentView.label} from favorites`
                    : `Add ${currentView.label} to favorites`
                }
                title={
                  currentIsFav
                    ? `Remove "${currentView.label}" from favorites`
                    : `Add "${currentView.label}" to favorites`
                }
                style={{
                  background: currentIsFav ? "rgba(245,158,11,0.15)" : "transparent",
                  color: currentIsFav ? C.star : C.textSub,
                  border: `1px solid ${currentIsFav ? C.star : C.border}`,
                  borderRadius: 999,
                  padding: "2px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  lineHeight: 1.4,
                }}
              >
                <span style={{ color: currentIsFav ? C.star : C.textDim }}>
                  {currentIsFav ? "★" : "☆"}
                </span>
                <span>
                  {currentIsFav ? "Unstar" : "Star"} this view
                </span>
                <span style={{ color: C.textDim, fontSize: 10 }}>
                  — {currentView.label}
                </span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => void setCollapsedSafe(true)}
              aria-label="Collapse favorites strip"
              title="Collapse favorites"
              style={{
                background: "transparent",
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.textDim,
                fontSize: 13,
                lineHeight: 1,
                cursor: "pointer",
                padding: "2px 8px",
              }}
            >
              ▴
            </button>
          </div>
        </div>

        {/* Body — grouped columns across the screen */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            padding: "8px 12px",
            gap: 12,
            minHeight: 56,
            // Strip is one row high overall — columns scroll vertically
            // within themselves if they overflow.
            maxHeight: 140,
          }}
        >
          {loading && favorites.length === 0 ? (
            <div
              data-testid="favorites-loading"
              style={{ color: C.textDim, fontSize: 12, padding: 6 }}
            >
              Loading favorites…
            </div>
          ) : favorites.length === 0 ? (
            <div
              data-testid="favorites-empty"
              style={{
                color: C.textDim,
                fontSize: 12,
                padding: 6,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 18, color: C.border }}>☆</span>
              <span>
                No favorites yet — click <strong style={{ color: C.textSub }}>Star this view</strong>
                {" "}on any panel to pin it here.
              </span>
            </div>
          ) : (
            grouped.map((col) => (
              <div
                key={col.group}
                data-testid={`favorites-column-${col.group}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: C.textDim,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    fontWeight: 700,
                    paddingLeft: 4,
                    marginBottom: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={col.group}
                >
                  {col.group}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    overflowY: "auto",
                    overflowX: "hidden",
                    paddingRight: 2,
                  }}
                >
                  {col.items.map((k) => {
                    const meta = MENU_KEY_BY_KEY[k];
                    const label = meta?.label ?? k;
                    const route = meta?.route ?? "/";
                    const icon = meta?.icon;
                    return (
                      <div
                        key={k}
                        data-testid={`favorites-item-${k}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          borderRadius: 4,
                          padding: "3px 6px",
                          background: "transparent",
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLDivElement).style.background = C.panelHi;
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLDivElement).style.background = "transparent";
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => navigate(route)}
                          title={meta ? `${meta.app.toUpperCase()} — ${label}` : label}
                          style={{
                            flex: 1,
                            background: "transparent",
                            border: "none",
                            color: C.textSub,
                            textAlign: "left",
                            fontSize: 12,
                            cursor: "pointer",
                            padding: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            minWidth: 0,
                          }}
                        >
                          {icon && (
                            <span style={{ width: 14, textAlign: "center", flexShrink: 0 }}>
                              {icon}
                            </span>
                          )}
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {label}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeKey(k)}
                          aria-label={`Remove ${label} from favorites`}
                          title="Remove"
                          style={{
                            background: "transparent",
                            border: "none",
                            color: C.textDim,
                            cursor: "pointer",
                            fontSize: 11,
                            lineHeight: 1,
                            padding: "0 2px",
                            flexShrink: 0,
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.color = C.remove;
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.color = C.textDim;
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <FavoritesToastStack />
    </>
  );
}
