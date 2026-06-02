// Tangerine P10-5 — Top-bar entity-switcher dropdown.
//
// Fixed-position dropdown in the upper-right corner. Hidden whenever
// the operator has 0 or 1 entities — single-entity users (the majority
// today) get no chrome. As more entities come online (RingOfFire +
// Xoro mirror + future B2B sub-tenants) the switcher reveals itself.
//
// Behaviour:
//   • Closed: pill button showing the current entity's code + name.
//   • Open: drop-down list, one row per entity, with:
//       - code + name
//       - star icon (★) if is_default
//       - "Switch" button → calls switchEntity() → sessionStorage +
//         window.location.reload(). Disabled for the active entity.
//       - "Set as default" link → calls setDefault(). Hidden on the
//         row that's already default.
//   • Footer: small "?" tooltip that explains what entity-switching
//     does in 2 lines of body copy.
//
// Style: matches FavoritesDrawer / SettingsDropdown — dark slate
// panel, blue accent for active states, inline styles (the repo
// doesn't ship Tailwind).
//
// Mount point: each app shell mounts <EntitySwitcher /> alongside
// FavoritesDrawer. The component is fixed-position so it's safe to
// drop in next to whatever header chrome the shell already has — no
// flex layout coordination required.

import { useEffect, useRef, useState } from "react";
import { useEntities } from "../hooks/useEntities";

// Tanda-ish slate palette (matches FavoritesDrawer).
const C = {
  panel:    "#1E293B",
  panelHi:  "#334155",
  border:   "#334155",
  text:     "#F1F5F9",
  textDim:  "#94A3B8",
  textSub:  "#CBD5E1",
  accent:   "#3B82F6",
  star:     "#F59E0B",
  link:     "#60A5FA",
};

function formatEntityLabel(code: string | null, name: string): string {
  if (code && name) return `${code} — ${name}`;
  return code || name || "(unnamed)";
}

export default function EntitySwitcher() {
  const {
    entities,
    currentEntityId,
    switchEntity,
    setDefault,
    error,
  } = useEntities();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // entity_id being switched/defaulted
  const [localError, setLocalError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click to close — same pattern as SettingsDropdown.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Single-entity (or unauthenticated / empty) operators get NO chrome.
  // Anchored to render-time entities length so the chrome disappears
  // immediately on the next render after a refetch returns 1 row.
  if (entities.length < 2) {
    return null;
  }

  const current = entities.find((e) => e.id === currentEntityId) ?? entities[0];

  async function onSwitch(entityId: string) {
    if (busy) return;
    setBusy(entityId);
    setLocalError(null);
    try {
      await switchEntity(entityId);
      // switchEntity reloads the window. The setBusy(null) below only
      // runs in tests where reloadFn is stubbed.
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSetDefault(entityId: string) {
    if (busy) return;
    setBusy(entityId);
    setLocalError(null);
    try {
      await setDefault(entityId);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      ref={ref}
      data-testid="entity-switcher"
      style={{
        position: "fixed",
        top: 12,
        right: 16,
        zIndex: 60,
        fontFamily: "inherit",
      }}
    >
      <button
        type="button"
        data-testid="entity-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Active entity: ${formatEntityLabel(current.code, current.name)}. Click to switch.`}
        title="Switch entity"
        style={{
          padding: "7px 12px",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: open ? C.panelHi : C.panel,
          color: C.text,
          fontWeight: 600,
          cursor: "pointer",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        }}
      >
        <span style={{ color: C.accent }}>◆</span>
        <span data-testid="entity-switcher-current-code" style={{ color: C.text }}>{current.code ?? "?"}</span>
        <span style={{ color: C.textDim, fontWeight: 400 }}>{current.name}</span>
        <span style={{ fontSize: 9, color: C.textDim, marginLeft: 4 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          data-testid="entity-switcher-menu"
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 280,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
            color: C.text,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              borderBottom: `1px solid ${C.border}`,
              background: C.panelHi,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: C.textSub,
            }}
          >
            Switch entity
          </div>

          {(localError || error) && (
            <div
              data-testid="entity-switcher-error"
              style={{
                padding: "8px 12px",
                background: "#7F1D1D",
                color: "#FECACA",
                fontSize: 11,
              }}
            >
              {localError || error}
            </div>
          )}

          <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 320, overflowY: "auto" }}>
            {entities.map((e) => {
              const isActive = e.id === current.id;
              const isBusy = busy === e.id;
              return (
                <li
                  key={e.id}
                  data-testid={`entity-row-${e.id}`}
                  style={{
                    padding: "8px 12px",
                    borderBottom: `1px solid ${C.border}`,
                    background: isActive ? C.panelHi : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    {e.is_default && (
                      <span data-testid={`entity-default-star-${e.id}`} title="Default entity" style={{ color: C.star }}>★</span>
                    )}
                    <span style={{ fontWeight: 700, color: C.text, fontSize: 13 }}>{e.code ?? "?"}</span>
                    <span style={{ color: C.textSub, fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.name}
                    </span>
                    {isActive && (
                      <span style={{ fontSize: 10, color: C.accent, textTransform: "uppercase", letterSpacing: 0.6 }}>
                        Active
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
                    <button
                      type="button"
                      data-testid={`entity-switch-btn-${e.id}`}
                      onClick={() => onSwitch(e.id)}
                      disabled={isActive || isBusy}
                      style={{
                        background: isActive ? "transparent" : C.accent,
                        border: isActive ? `1px solid ${C.border}` : "none",
                        color: isActive ? C.textDim : "#fff",
                        borderRadius: 6,
                        padding: "4px 10px",
                        cursor: isActive || isBusy ? "default" : "pointer",
                        fontSize: 11,
                        fontWeight: 600,
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      {isActive ? "Current" : isBusy ? "Switching…" : "Switch"}
                    </button>
                    {!e.is_default && (
                      <button
                        type="button"
                        data-testid={`entity-set-default-btn-${e.id}`}
                        onClick={() => onSetDefault(e.id)}
                        disabled={isBusy}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: C.link,
                          cursor: isBusy ? "default" : "pointer",
                          fontSize: 11,
                          padding: 0,
                          textDecoration: "underline",
                          opacity: isBusy ? 0.6 : 1,
                        }}
                      >
                        Set as default
                      </button>
                    )}
                    <span style={{ color: C.textDim, fontSize: 10, marginLeft: "auto" }}>{e.role}</span>
                  </div>
                </li>
              );
            })}
          </ul>

          <div
            data-testid="entity-switcher-footer"
            style={{
              padding: "8px 12px",
              borderTop: `1px solid ${C.border}`,
              background: C.panelHi,
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
              color: C.textDim,
            }}
          >
            <span
              title="Switching scopes every panel + report to the selected entity for the current tab. Setting a default persists the choice across sessions."
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: C.border,
                color: C.textSub,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                cursor: "help",
              }}
            >
              ?
            </span>
            <span>Switching scopes data to the chosen entity for this tab.</span>
          </div>
        </div>
      )}
    </div>
  );
}
