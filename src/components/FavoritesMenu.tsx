// Cross-cutter T4 — Favorites NAV MENU (operator redesign 2026-05-30).
//
// Replaces the old full-width FavoritesDrawer / floating-pill approach,
// which the operator rejected ("drawer just not working correctly — remove
// the drawer completely in all apps"). The new model is a single, simple
// nav-bar menu item, placed at the right end of every app's nav:
//
//   ┌─────────────┐
//   │ ★ Favorites │ ▾     ← one nav button, same look in every app
//   └─────────────┘
//        │ click
//        ▼
//   ┌────────────────────────────┐
//   │ ☆ Star this view           │   ← star/unstar the CURRENT view
//   │ ────────────────────────── │
//   │ ★ Style Master        ×    │   ← starred views, click to open
//   │ ★ Journal Entry       ×    │
//   └────────────────────────────┘
//
// Two operator requirements, both satisfied by this one component:
//   • "add a menu item for favorites as the first from the right" — each app
//     mounts <FavoritesMenu /> as the right-most interactive control before
//     its account/home chrome.
//   • "make sure that on each app view user has a way to star it as
//     favorite" — the dropdown's top row stars/unstars whatever view the URL
//     currently resolves to, so the affordance rides along on every view
//     without having to wire a star into each panel header.
//
// "Make it simplistic in look": one neutral translucent button + a compact
// dark-slate dropdown. No grouped columns, no body padding shifts, no
// per-page layout math — just a menu.
//
// Style: inline styles (repo doesn't use Tailwind), dark-slate chrome
// matching the app headers.

import { useEffect, useRef, useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";
import { MENU_KEY_BY_KEY, MENU_KEYS } from "../lib/menuKeys";

// Tangerine module key (?m=<key>, e.g. "journal_entries") → menu_key. Tangerine
// menu entries are the app:"tanda" rows whose route is /tangerine?m=<moduleKey>
// (the Tangerine shell selects its active module from ?m=, NOT ?view= — that
// belongs to the separate TandA / PO-WIP shell at /tanda). We derive the map
// from the registry's route field so it can't drift from menuKeys.ts.
const TANGERINE_MODULE_TO_MENU_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of MENU_KEYS) {
    if (e.app !== "tanda") continue;
    const match = (e.route || "").match(/[?&]m=([^&]+)/);
    if (match) m[match[1]] = e.key;
  }
  return m;
})();
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

// Dark-slate palette — matches every app header.
const C = {
  panel:   "#1E293B",
  panelHi: "#334155",
  border:  "#334155",
  text:    "#F1F5F9",
  textDim: "#94A3B8",
  textSub: "#CBD5E1",
  star:    "#F59E0B",
  remove:  "#EF4444",
};

// ── Current-view detection ────────────────────────────────────────────────
//
// All five apps drive their active panel from a URL query string (view=,
// tab=, or report=). We read window.location directly because the apps use
// a mix of routers and this component mounts inside each app's nav — the URL
// is the only common contract.

export interface CurrentView {
  menuKey: string | null;
  label: string;
}

export function detectCurrentView(): CurrentView {
  if (typeof window === "undefined") return { menuKey: null, label: "this view" };
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  let menuKey: string | null = null;

  if (path.startsWith("/tangerine")) {
    // Tangerine tracks the active module in ?m=<moduleKey> (set on every nav).
    menuKey = TANGERINE_MODULE_TO_MENU_KEY[params.get("m") || ""] ?? null;
  } else if (path.startsWith("/tanda")) {
    menuKey = tandaViewToMenuKey(params.get("view") || "dashboard");
  } else if (path.startsWith("/ats")) {
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
    // Many panels swap via setState without a real URL change; poll at a
    // low rate so the "Star this view" row tracks view changes that don't
    // go through history.
    const t = window.setInterval(update, 750);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.clearInterval(t);
    };
  }, []);
  return cv;
}

// ── Inline toast renderer ─────────────────────────────────────────────────
// Ported from the old drawer so "Added / Removed from favorites" feedback
// survives the redesign. One instance per app (one menu per app).

function FavoritesToastStack(): JSX.Element | null {
  const [toasts, setToasts] = useState<FavoritesToast[]>([]);
  useEffect(() => {
    const unsub = subscribeFavoritesToasts((t) => {
      setToasts((cur) => [...cur, t]);
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
        position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)",
        zIndex: 1200, display: "flex", flexDirection: "column", gap: 6, pointerEvents: "none",
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
            padding: "8px 14px", borderRadius: 6, boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
            fontSize: 13, display: "flex", alignItems: "center", gap: 8,
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

interface FavoritesMenuProps {
  /**
   * Optional style override for the trigger button so an app can match its
   * own nav chrome exactly. Omit for the default neutral translucent pill,
   * which reads fine on every (dark) app header.
   */
  buttonStyle?: React.CSSProperties;
}

export default function FavoritesMenu({ buttonStyle }: FavoritesMenuProps): JSX.Element {
  const { favorites, toggleFavorite, logClick } = usePersonalization();
  const currentView = useCurrentView();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const currentIsFav = currentView.menuKey ? favorites.includes(currentView.menuKey) : false;

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function navigate(menuKey: string, route: string): void {
    if (typeof window === "undefined") return;
    logClick(menuKey);
    window.location.href = route;
  }

  async function removeKey(menuKey: string): Promise<void> {
    const label = MENU_KEY_BY_KEY[menuKey]?.label ?? menuKey;
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

  const defaultButtonStyle: React.CSSProperties = {
    background: open ? "rgba(255,255,255,0.12)" : "transparent",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    color: "rgba(255,255,255,0.88)",
    padding: "7px 12px",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-testid="favorites-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Favorites"
        onClick={() => setOpen((v) => !v)}
        style={{ ...defaultButtonStyle, ...buttonStyle }}
      >
        <span style={{ color: C.star }}>★</span>
        <span>Favorites</span>
        {favorites.length > 0 && (
          <span style={{ fontSize: 10, opacity: 0.7 }}>({favorites.length})</span>
        )}
        <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="favorites-menu-dropdown"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 280,
            maxWidth: 340,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            zIndex: 200,
            overflow: "hidden",
            fontFamily: "inherit",
          }}
        >
          {/* Star-this-view row */}
          <div style={{ padding: 6, borderBottom: `1px solid ${C.border}` }}>
            {currentView.menuKey ? (
              <button
                type="button"
                data-testid="favorites-menu-star-current"
                onClick={() => void toggleCurrent()}
                aria-pressed={currentIsFav}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: currentIsFav ? "rgba(245,158,11,0.12)" : "transparent",
                  border: "none",
                  borderRadius: 6,
                  color: C.text,
                  padding: "9px 10px",
                  fontSize: 13,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = currentIsFav ? "rgba(245,158,11,0.12)" : "transparent"; }}
              >
                <span style={{ color: currentIsFav ? C.star : C.textDim, fontSize: 16 }}>
                  {currentIsFav ? "★" : "☆"}
                </span>
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>
                    {currentIsFav ? "Starred — click to remove" : "Star this view"}
                  </span>
                  <span style={{ fontSize: 11, color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {currentView.label}
                  </span>
                </span>
              </button>
            ) : (
              <div style={{ padding: "9px 10px", fontSize: 12, color: C.textDim, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>☆</span>
                <span>This view can’t be favorited.</span>
              </div>
            )}
          </div>

          {/* Favorites list */}
          <div style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.textDim, padding: "4px 6px 6px" }}>
              Your favorites{favorites.length > 0 ? ` (${favorites.length})` : ""}
            </div>
            {favorites.length === 0 ? (
              <div data-testid="favorites-menu-empty" style={{ padding: "6px 8px 10px", fontSize: 12, color: C.textDim, lineHeight: 1.5 }}>
                No favorites yet — open a view and click <span style={{ color: C.textSub }}>☆ Star this view</span>.
              </div>
            ) : (
              favorites.map((k) => {
                const meta = MENU_KEY_BY_KEY[k];
                const label = meta?.label ?? k;
                const route = meta?.route ?? "/";
                const icon = meta?.icon;
                const appTag = meta?.app ? meta.app.toUpperCase() : null;
                return (
                  <div
                    key={k}
                    data-testid={`favorites-menu-item-${k}`}
                    style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 6, padding: "2px 4px" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = C.panelHi; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                  >
                    <button
                      type="button"
                      onClick={() => navigate(k, route)}
                      title={appTag ? `${appTag} — ${label}` : label}
                      style={{
                        flex: 1, minWidth: 0, background: "transparent", border: "none",
                        color: C.textSub, textAlign: "left", fontSize: 13, cursor: "pointer",
                        padding: "7px 6px", display: "flex", alignItems: "center", gap: 8, fontFamily: "inherit",
                      }}
                    >
                      <span style={{ width: 16, textAlign: "center", flexShrink: 0, color: C.star }}>
                        {icon || "★"}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {label}
                      </span>
                      {appTag && (
                        <span style={{ fontSize: 9, color: C.textDim, flexShrink: 0, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 4px" }}>
                          {appTag}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeKey(k)}
                      aria-label={`Remove ${label} from favorites`}
                      title="Remove"
                      style={{
                        background: "transparent", border: "none", color: C.textDim,
                        cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 4px", flexShrink: 0,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = C.remove; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = C.textDim; }}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <FavoritesToastStack />
    </div>
  );
}
