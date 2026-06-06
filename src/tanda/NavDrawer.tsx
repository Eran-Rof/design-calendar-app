// src/tanda/NavDrawer.tsx
// Left-side navigation drawer for the Tangerine shell.
//
// Features:
//  - Collapsible to icon-only mode (56 px), expanded at 240 px.
//  - User info (avatar, name, email, sign-out popover).
//  - Live search bar — filters across all modules; Enter selects top hit.
//  - Favorites section always open: star/un-star the current view.
//  - Module list sorted by per-user usage (localStorage, fire-and-forget
//    server telemetry via existing logClick). Sections reorder as usage grows.
//  - Apps flyout at the bottom for switching between suite apps.
//  - Collapsed state persisted to localStorage key "tangerine:nav:collapsed:v1".
//  - Usage counts persisted to "tangerine:nav:counts:v1".

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";
import { MENU_KEYS } from "../lib/menuKeys";

// ── palette (dark-slate, matches existing Tangerine header) ───────────────
const C = {
  bg:        "#0b1220",
  bgRow:     "#1e293b",
  bgActive:  "#1d4ed8",
  text:      "#e2e8f0",
  textMuted: "#94a3b8",
  border:    "rgba(255,255,255,0.08)",
  section:   "#475569",
  star:      "#fbbf24",
  logo:      "linear-gradient(135deg,#f97316,#ea580c)",
};

export const DRAWER_W_OPEN   = 240;
export const DRAWER_W_CLOSED = 56;

// ── favorites: menu_key (registry) ↔ moduleKey (?m= param) ───────────────
const modToMenuKey: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const e of MENU_KEYS) {
    if (e.app !== "tanda") continue;
    const m = (e.route || "").match(/[?&]m=([^&]+)/);
    if (m) out[m[1]] = e.key;
  }
  return out;
})();
const menuKeyToMod: Record<string, string> = Object.fromEntries(
  Object.entries(modToMenuKey).map(([a, b]) => [b, a]),
);

// ── usage counts (localStorage) ───────────────────────────────────────────
const COUNTS_LS = "tangerine:nav:counts:v1";

function loadCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COUNTS_LS);
    const p = raw ? JSON.parse(raw) : {};
    return typeof p === "object" && p !== null ? p : {};
  } catch { return {}; }
}

function bumpCount(key: string, prev: Record<string, number>): Record<string, number> {
  const next = { ...prev, [key]: (prev[key] ?? 0) + 1 };
  try { localStorage.setItem(COUNTS_LS, JSON.stringify(next)); } catch {}
  return next;
}

// ── suite apps ────────────────────────────────────────────────────────────
const SUITE_APPS = [
  { href: "/",          emoji: "📅", label: "Design Calendar",  description: "Style cards and milestones" },
  { href: "/ats",       emoji: "📦", label: "ATS",              description: "Available-to-ship planning" },
  { href: "/tanda",     emoji: "📋", label: "PO WIP",           description: "Purchase order tracking" },
  { href: "/costing",   emoji: "💰", label: "Costing",          description: "Costing projects and margins" },
  { href: "/planning",  emoji: "📈", label: "Planning",         description: "Inventory forecasting" },
  { href: "/gs1",       emoji: "🏷️", label: "GS1",             description: "Prepack labels and SSCC" },
  { href: "/vendor",    emoji: "🌐", label: "Vendor Portal",    description: "External vendor view" },
];

// ── types ─────────────────────────────────────────────────────────────────
export interface NavModule {
  key: string;
  label: string;
  emoji: string;
  group: string;
}

export interface NavSection {
  section: string;
  emoji: string;
  groups: string[];
}

interface Props {
  activeModule: string | null;
  onSelectModule: (k: string | null) => void;
  userEmail: string | null;
  userName: string | null;
  userPhotoUrl?: string | null;
  onSignOut: () => void;
  modules: NavModule[];
  sections: NavSection[];
  canPlanning: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

// ── avatar helpers ────────────────────────────────────────────────────────
function deriveInitials(name?: string | null, email?: string | null): string {
  const src = (name || "").trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  return ((email || "?")[0]).toUpperCase();
}

function avatarBg(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const p = ["#3B82F6","#fb923c","#10B981","#8B5CF6","#EC4899","#F59E0B","#06B6D4","#EF4444"];
  return p[h % p.length];
}

// ── component ─────────────────────────────────────────────────────────────
export function NavDrawer({
  activeModule, onSelectModule,
  userEmail, userName, userPhotoUrl, onSignOut,
  modules, sections, canPlanning,
  collapsed, onToggleCollapsed,
}: Props) {
  const { favorites, toggleFavorite, logClick } = usePersonalization();
  const [counts, setCounts]     = useState<Record<string, number>>(loadCounts);
  const [search, setSearch]     = useState("");
  const [userOpen, setUserOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // cross-tab count sync
  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key === COUNTS_LS) setCounts(loadCounts()); };
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  }, []);

  // navigate: bump count + log click + call parent
  const navigate = useCallback((key: string) => {
    setCounts(prev => bumpCount(key, prev));
    const mk = modToMenuKey[key];
    if (mk) logClick(mk);
    onSelectModule(key);
    setSearch("");
    setAppsOpen(false);
  }, [logClick, onSelectModule]);

  // ── sorted sections + modules ─────────────────────────────────────────
  const sortedSections = useMemo(() => {
    const score = (s: NavSection) =>
      s.groups.flatMap(g => modules.filter(m => m.group === g))
              .reduce((n, m) => n + (counts[m.key] ?? 0), 0);
    return [...sections].sort((a, b) => score(b) - score(a));
  }, [sections, modules, counts]);

  const modsIn = useCallback((s: NavSection): NavModule[] =>
    [...modules.filter(m => s.groups.includes(m.group))]
      .sort((a, b) => (counts[b.key] ?? 0) - (counts[a.key] ?? 0)),
    [modules, counts],
  );

  // ── favorites ─────────────────────────────────────────────────────────
  const favMods = useMemo(() =>
    favorites
      .map(mk => menuKeyToMod[mk])
      .filter(Boolean)
      .map(key => modules.find(m => m.key === key))
      .filter(Boolean) as NavModule[],
    [favorites, modules],
  );
  const activeMenuKey = activeModule ? modToMenuKey[activeModule] : null;
  const isActiveFav   = !!activeMenuKey && favorites.includes(activeMenuKey);

  // ── search ────────────────────────────────────────────────────────────
  const q = search.toLowerCase();
  const searchHits = useMemo(() => {
    if (!q) return [];
    return [...modules]
      .filter(m => m.label.toLowerCase().includes(q) || m.emoji.includes(search))
      .sort((a, b) => (counts[b.key] ?? 0) - (counts[a.key] ?? 0))
      .slice(0, 18);
  }, [q, modules, counts, search]);

  // ── row style ─────────────────────────────────────────────────────────
  const rowStyle = (key: string): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: collapsed ? "7px 0" : "5px 10px",
    justifyContent: collapsed ? "center" : "flex-start",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: activeModule === key ? 600 : 400,
    background: activeModule === key ? C.bgActive : "transparent",
    color: activeModule === key ? "#fff" : C.text,
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    transition: "background 0.1s",
  });

  const hoverOn  = (e: React.MouseEvent<HTMLDivElement>, key: string) =>
    { (e.currentTarget as HTMLDivElement).style.background = activeModule === key ? C.bgActive : C.bgRow; };
  const hoverOff = (e: React.MouseEvent<HTMLDivElement>, key: string) =>
    { (e.currentTarget as HTMLDivElement).style.background = activeModule === key ? C.bgActive : "transparent"; };

  const av  = deriveInitials(userName, userEmail);
  const avBg = avatarBg(userName || userEmail || "");
  const w   = collapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN;

  return (
    <div
      style={{
        position: "fixed", top: 0, left: 0, bottom: 0,
        width: w, transition: "width 0.2s ease",
        background: C.bg, color: C.text,
        borderRight: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column",
        zIndex: 200, overflowX: "hidden", overflowY: "hidden",
      }}
      onClick={() => userOpen && setUserOpen(false)}
    >
      {/* ── Logo / collapse ───────────────────────────────────────── */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 8px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <button
          onClick={e => { e.stopPropagation(); onToggleCollapsed(); }}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:16, padding:"3px 5px", lineHeight:1, flexShrink:0, borderRadius:4 }}
          onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
          onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
        >
          {collapsed ? "▶" : "◀"}
        </button>
        {!collapsed && (
          <>
            <div
              onClick={e => { e.stopPropagation(); onSelectModule(null); }}
              title="Tangerine home"
              style={{ width:28, height:28, borderRadius:6, background:C.logo, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:14, color:"#fff", flexShrink:0, cursor:"pointer" }}
            >T</div>
            <span
              style={{ fontWeight:700, fontSize:15, letterSpacing:0.3, cursor:"pointer", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}
              onClick={e => { e.stopPropagation(); onSelectModule(null); }}
            >Tangerine</span>
          </>
        )}
      </div>

      {/* ── User info ─────────────────────────────────────────────── */}
      <div
        style={{ padding: collapsed ? "10px 4px" : "10px 10px", borderBottom:`1px solid ${C.border}`, flexShrink:0, position:"relative", cursor: collapsed ? "default" : "pointer" }}
        onClick={e => { e.stopPropagation(); if (!collapsed) setUserOpen(v => !v); }}
      >
        <div style={{ display:"flex", alignItems:"center", gap:8, justifyContent: collapsed ? "center" : "flex-start" }}>
          {userPhotoUrl
            ? <img src={userPhotoUrl} alt={userName || ""} style={{ width:32, height:32, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
            : <span style={{ width:32, height:32, borderRadius:"50%", background:avBg, color:"#fff", fontSize:12, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{av}</span>
          }
          {!collapsed && (
            <div style={{ overflow:"hidden", flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{userName || userEmail}</div>
              {userName && <div style={{ fontSize:11, color:C.textMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{userEmail}</div>}
            </div>
          )}
          {!collapsed && <span style={{ color:C.textMuted, fontSize:11 }}>{userOpen ? "▴" : "▾"}</span>}
        </div>
        {!collapsed && userOpen && (
          <div
            style={{ position:"absolute", top:"100%", left:10, right:10, background:"#1e293b", borderRadius:6, border:`1px solid ${C.border}`, zIndex:10, padding:4, marginTop:2 }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => { setUserOpen(false); onSignOut(); }}
              style={{ display:"block", width:"100%", textAlign:"left", background:"none", border:"none", color:C.text, padding:"7px 10px", cursor:"pointer", fontSize:13, borderRadius:4 }}
              onMouseEnter={e => { e.currentTarget.style.background = C.bgRow; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >Sign out</button>
          </div>
        )}
      </div>

      {/* ── Search ────────────────────────────────────────────────── */}
      <div style={{ padding: collapsed ? "8px 4px" : "8px 8px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        {collapsed ? (
          <button
            title="Search (expand to use)"
            onClick={e => { e.stopPropagation(); onToggleCollapsed(); setTimeout(() => searchRef.current?.focus(), 220); }}
            style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:16, width:"100%", textAlign:"center", lineHeight:1, padding:"3px 0" }}
          >🔍</button>
        ) : (
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") setSearch("");
              if (e.key === "Enter" && searchHits.length) navigate(searchHits[0].key);
            }}
            placeholder="Search modules…"
            style={{ width:"100%", background:"#1e293b", border:"none", borderRadius:6, padding:"6px 10px", color:C.text, fontSize:13, outline:"none", boxSizing:"border-box" }}
          />
        )}
      </div>

      {/* ── Scrollable body ───────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:"auto", overflowX:"hidden" }}>

        {/* search results */}
        {!collapsed && search && (
          <div style={{ padding:"4px" }}>
            {searchHits.length === 0
              ? <div style={{ color:C.textMuted, fontSize:12, padding:"8px 12px" }}>No matches</div>
              : searchHits.map(m => (
                <div key={m.key} style={rowStyle(m.key)}
                  onClick={e => { e.stopPropagation(); navigate(m.key); }}
                  onMouseEnter={e => hoverOn(e, m.key)}
                  onMouseLeave={e => hoverOff(e, m.key)}
                >
                  <span style={{ fontSize:15, flexShrink:0 }}>{m.emoji}</span>
                  <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{m.label}</span>
                </div>
              ))
            }
          </div>
        )}

        {/* ── Favorites (always open, never hidden) ── */}
        {!search && (
          <div style={{ padding:"0 4px" }}>
            {collapsed ? (
              <div title="Favorites" style={{ textAlign:"center", padding:"10px 0 5px", color:C.star, fontSize:15 }}>⭐</div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 10px 5px" }}>
                <span style={{ fontSize:11, fontWeight:700, color:C.section, letterSpacing:0.9, textTransform:"uppercase" }}>⭐ Favorites</span>
                {activeModule && (
                  <button
                    title={isActiveFav ? "Remove from favorites" : "Star this view"}
                    onClick={e => { e.stopPropagation(); const mk = modToMenuKey[activeModule ?? ""]; if (mk) void toggleFavorite(mk); }}
                    style={{ background:"none", border:"none", cursor:"pointer", fontSize:16, color: isActiveFav ? C.star : C.textMuted, padding:0, lineHeight:1 }}
                  >{isActiveFav ? "★" : "☆"}</button>
                )}
              </div>
            )}

            {!collapsed && favMods.length === 0 && (
              <div style={{ color:C.textMuted, fontSize:12, padding:"2px 10px 8px", fontStyle:"italic" }}>
                Use ☆ to star the current view
              </div>
            )}

            {favMods.map(m => (
              <div key={m.key} style={rowStyle(m.key)} title={collapsed ? m.label : undefined}
                onClick={e => { e.stopPropagation(); navigate(m.key); }}
                onMouseEnter={e => hoverOn(e, m.key)}
                onMouseLeave={e => hoverOff(e, m.key)}
              >
                <span style={{ fontSize:15, flexShrink:0 }}>{m.emoji}</span>
                {!collapsed && <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{m.label}</span>}
              </div>
            ))}

            <div style={{ height:1, background:C.border, margin:"6px 0" }} />
          </div>
        )}

        {/* ── Usage-sorted module sections ── */}
        {!search && sortedSections.map(sec => {
          const mods = modsIn(sec);
          if (!mods.length) return null;
          return (
            <div key={sec.section} style={{ padding:"0 4px" }}>
              {collapsed ? (
                <div title={sec.section} style={{ textAlign:"center", padding:"8px 0 3px", fontSize:14, color:C.section }}>{sec.emoji}</div>
              ) : (
                <div style={{ fontSize:11, fontWeight:700, color:C.section, letterSpacing:0.9, textTransform:"uppercase", padding:"8px 10px 3px", display:"flex", alignItems:"center", gap:5 }}>
                  <span>{sec.emoji}</span><span>{sec.section}</span>
                </div>
              )}
              {mods.map(m => (
                <div key={m.key} style={rowStyle(m.key)} title={collapsed ? m.label : undefined}
                  onClick={e => { e.stopPropagation(); navigate(m.key); }}
                  onMouseEnter={e => hoverOn(e, m.key)}
                  onMouseLeave={e => hoverOff(e, m.key)}
                >
                  <span style={{ fontSize:14, flexShrink:0 }}>{m.emoji}</span>
                  {!collapsed && (
                    <>
                      <span style={{ overflow:"hidden", textOverflow:"ellipsis", flex:1 }}>{m.label}</span>
                      {(counts[m.key] ?? 0) > 0 && (
                        <span style={{ fontSize:10, color:C.textMuted, flexShrink:0 }}>{counts[m.key]}</span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}

        {/* Planning external link */}
        {!search && canPlanning && (
          <div style={{ padding:"0 4px" }}>
            <div style={{ height:1, background:C.border, margin:"6px 0" }} />
            <a
              href="/planning/wholesale" target="_blank" rel="noopener"
              title="Inventory Planning (opens in new tab)"
              style={{ display:"flex", alignItems:"center", gap:8, padding: collapsed ? "7px 0" : "5px 10px", borderRadius:6, textDecoration:"none", color:C.textMuted, fontSize:13, whiteSpace:"nowrap", justifyContent: collapsed ? "center" : "flex-start", transition:"background 0.1s" }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.background = C.bgRow; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ fontSize:14 }}>📈</span>
              {!collapsed && <><span>Planning</span><span style={{ fontSize:10, opacity:0.5 }}>↗</span></>}
            </a>
          </div>
        )}
      </div>

      {/* ── Apps switcher at bottom ───────────────────────────────── */}
      <div style={{ borderTop:`1px solid ${C.border}`, padding:"4px 4px", flexShrink:0, position:"relative" }}>
        <button
          onClick={e => { e.stopPropagation(); setAppsOpen(v => !v); }}
          title="Switch app"
          style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background: appsOpen ? C.bgRow : "none", border:"none", color: appsOpen ? C.text : C.textMuted, cursor:"pointer", borderRadius:6, padding: collapsed ? "7px 0" : "6px 10px", fontSize:13, justifyContent: collapsed ? "center" : "flex-start", transition:"background 0.1s" }}
          onMouseEnter={e => { e.currentTarget.style.background = C.bgRow; e.currentTarget.style.color = C.text; }}
          onMouseLeave={e => { if (!appsOpen) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; } }}
        >
          <span style={{ fontSize:15 }}>🧩</span>
          {!collapsed && <span>All Apps</span>}
        </button>

        {/* Apps flyout — pops above the button, to the right of the drawer */}
        {appsOpen && (
          <>
            <div onClick={e => { e.stopPropagation(); setAppsOpen(false); }} style={{ position:"fixed", inset:0, zIndex:290 }} aria-hidden />
            <div
              style={{
                position:"fixed",
                bottom: 8,
                left: w + 8,
                width: 320,
                background: "#1e293b",
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: 10,
                zIndex: 300,
                boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize:11, color:C.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:8, padding:"0 4px" }}>Suite Apps</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                {SUITE_APPS.map(a => (
                  <a
                    key={a.href} href={a.href} target="_blank" rel="noopener"
                    style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", borderRadius:7, textDecoration:"none", color:C.text, background:"transparent", transition:"background 0.12s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                    title={a.description}
                  >
                    <span style={{ fontSize:18 }}>{a.emoji}</span>
                    <div style={{ display:"flex", flexDirection:"column", lineHeight:1.2, minWidth:0 }}>
                      <span style={{ fontSize:12, fontWeight:600 }}>{a.label}</span>
                      <span style={{ fontSize:10, color:C.textMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.description}</span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
