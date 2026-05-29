// Cross-cutter T4-3 — Favorites side drawer.
//
// Right-side collapsible drawer (default open) that lists the operator's
// pinned menu_keys as clickable buttons. Mounts once per app shell —
// every app embeds <FavoritesDrawer /> at the top level so the same UI
// is reachable from anywhere.
//
// Behaviour:
//   • Fetches /preferences on first mount via the shared
//     usePersonalization hook (no extra fetch beyond what the hook
//     already does).
//   • Each favorite row → click navigates to MENU_KEY_BY_KEY[k].route.
//     We use window.location.href because the app uses a mix of routers
//     and most routes are query-string variants on /tanda, /ats, /design.
//   • "x" on each row → toggleFavorite (the same hook the star uses).
//   • Collapse state persisted in localStorage at "favorites_drawer_open".
//   • Empty state when favorites.length === 0.
//
// Style: matches Tanda's dark-slate chrome (used app-wide) via inline
// styles since the repo doesn't use Tailwind. Conventions cribbed from
// src/tanda/styles.ts.

import { useEffect, useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";
import { MENU_KEY_BY_KEY } from "../lib/menuKeys";

const LOCAL_STORAGE_KEY = "favorites_drawer_open";

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
};

function readPersistedOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (v === null) return true; // default open
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

function writePersistedOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LOCAL_STORAGE_KEY, open ? "1" : "0"); } catch { /* ignore */ }
}

export default function FavoritesDrawer() {
  const { favorites, toggleFavorite, loading } = usePersonalization();
  const [open, setOpen] = useState<boolean>(() => readPersistedOpen());

  useEffect(() => { writePersistedOpen(open); }, [open]);

  function navigate(route: string) {
    if (typeof window === "undefined") return;
    window.location.href = route;
  }

  async function remove(menuKey: string) {
    try { await toggleFavorite(menuKey); } catch { /* hook rolls back */ }
  }

  // Collapsed: just a thin vertical tab on the right edge.
  if (!open) {
    return (
      <div
        data-testid="favorites-drawer-collapsed"
        style={{
          position: "fixed",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          zIndex: 50,
        }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open favorites drawer"
          title="Open favorites"
          style={{
            background: C.panel,
            color: C.text,
            border: `1px solid ${C.border}`,
            borderRight: "none",
            borderTopLeftRadius: 6,
            borderBottomLeftRadius: 6,
            padding: "10px 6px",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ color: C.star }}>★</span>
          <span style={{ fontSize: 10, color: C.textDim, writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            Favorites
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="favorites-drawer"
      role="complementary"
      aria-label="Favorites"
      style={{
        position: "fixed",
        right: 0,
        top: 64,
        bottom: 0,
        width: 240,
        zIndex: 50,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        boxShadow: "-4px 0 16px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        color: C.text,
        fontFamily: "inherit",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: `1px solid ${C.border}`,
          background: C.panelHi,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: C.star }}>★</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Favorites
          </span>
          {favorites.length > 0 && (
            <span style={{ fontSize: 10, color: C.textDim }}>({favorites.length})</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse favorites drawer"
          title="Collapse"
          style={{
            background: "transparent",
            border: "none",
            color: C.textDim,
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: 2,
          }}
        >
          ›
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
        {loading && favorites.length === 0 ? (
          <div style={{ padding: 12, color: C.textDim, fontSize: 12, textAlign: "center" }}>
            Loading…
          </div>
        ) : favorites.length === 0 ? (
          <div
            data-testid="favorites-empty"
            style={{
              padding: "24px 12px",
              color: C.textDim,
              fontSize: 12,
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontSize: 28, color: C.border, marginBottom: 6 }}>☆</div>
            Star any menu item to pin it here.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {favorites.map((k) => {
              const meta = MENU_KEY_BY_KEY[k];
              const label = meta?.label ?? k;
              const route = meta?.route ?? "/";
              const icon = meta?.icon;
              return (
                <li key={k} style={{ marginBottom: 2 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      borderRadius: 6,
                      padding: "6px 8px",
                      background: "transparent",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = C.panelHi; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
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
                        fontSize: 13,
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      {icon && <span style={{ width: 16, textAlign: "center" }}>{icon}</span>}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {label}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(k)}
                      aria-label={`Remove ${label} from favorites`}
                      title="Remove"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: C.textDim,
                        cursor: "pointer",
                        fontSize: 13,
                        lineHeight: 1,
                        padding: 2,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = C.remove; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = C.textDim; }}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
