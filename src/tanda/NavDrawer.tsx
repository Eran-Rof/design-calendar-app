// src/tanda/NavDrawer.tsx
// Left-side navigation drawer for the Tangerine shell.
//
// Features:
//  - Collapsible to 56 px icon-only / 240 px labeled, state in localStorage.
//  - User info: avatar + name only (no email), sign-out popover on click.
//  - Live search bar. Enter selects top hit. Esc clears.
//  - Favorites section always open — star/un-star the active view.
//  - Accordion module list: section headers click to expand/collapse.
//    Active module's section auto-opens. Usage-sorted (sections with highest
//    cumulative count float up; items within sort by individual count).
//  - Apps flyout at the bottom.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersonalization } from "../hooks/usePersonalization";
import { MENU_KEYS } from "../lib/menuKeys";

// ── palette ───────────────────────────────────────────────────────────────
const C = {
  bg:        "#0b1220",
  bgRow:     "#1e293b",
  bgActive:  "rgba(59,130,246,0.16)",  // faded blue tint (was bright #1d4ed8)
  text:      "#e2e8f0",
  textMuted: "#94a3b8",
  border:    "rgba(255,255,255,0.08)",
  section:   "#475569",
  star:      "#fbbf24",
  logo:      "linear-gradient(135deg,#f97316,#ea580c)",
};

export const DRAWER_W_OPEN   = 240;
export const DRAWER_W_CLOSED = 56;
export const TOPBAR_H        = 40;   // slim top bar height consumed by content

// ── favorites: menu_key (registry) ↔ moduleKey (?m= param) ───────────────
// Computed inside the component now (keyed by the appKey prop) so each app
// resolves its own menu_key rows. See modToMenuKey/menuKeyToMod useMemos below.

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
  { href: "/",         label: "Design Calendar",  description: "Style cards and milestones" },
  { href: "/ats",      label: "ATS",              description: "Available-to-ship planning" },
  { href: "/tanda",    label: "PO WIP",           description: "Purchase order tracking" },
  { href: "/costing",  label: "Costing",          description: "Costing projects and margins" },
  { href: "/planning", label: "Planning",         description: "Inventory forecasting" },
  { href: "/gs1",      label: "GS1",             description: "Prepack labels and SSCC" },
  { href: "/vendor",   label: "Vendor Portal",    description: "External vendor view" },
];

// ── types ─────────────────────────────────────────────────────────────────
export interface NavModule  { key: string; label: string; emoji: string; group: string; }
export interface NavSection { section: string; emoji: string; groups: string[]; }

interface Props {
  activeModule: string | null;
  onSelectModule: (k: string | null) => void;
  userEmail: string | null;
  userName: string | null;
  userPhotoUrl?: string | null;
  onSignOut: () => void;
  modules: NavModule[];
  sections: NavSection[];
  /** Optional per-group icon, keyed by group name — shown on group sub-headers. */
  groupIcons?: Record<string, string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** App identity — filters favorites/telemetry menu_key rows + drawer branding.
   *  Defaults preserve the Tangerine shell's existing behavior. */
  appKey?: string;
  appLabel?: string;
  logoText?: string;
  /** Query param in menu_key routes that carries the module key (Tangerine="m",
   *  GS1="tab", Costing="view", …). Used to resolve favorites/telemetry. */
  moduleParam?: string;
  /** Optional app-specific content rendered below the app name and above the
   *  user section (e.g. a notifications bell). Hidden when collapsed. */
  headerSlot?: React.ReactNode;
  /** Optional app-specific tools rendered as a section just above the bottom
   *  Apps switcher (e.g. DC's List/Grid · Activity · Settings). Hidden when
   *  collapsed. */
  toolsSlot?: React.ReactNode;
  /** App-name header row height (px). Defaults to TOPBAR_H (40) so the header
   *  lines up with each app's slim top bar. Apps with a taller top bar (e.g.
   *  Design Calendar's 64px header) pass a smaller value here together with
   *  userBoxHeight so the app-name + user box together end on the top-bar line. */
  headerHeight?: number;
  /** Optional fixed height (px) for the user box. When set, the box is sized
   *  exactly (with the avatar shrunk to fit) instead of growing to its content
   *  — used to bottom-align the app-name + user region to a taller top bar. */
  userBoxHeight?: number;
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

// ── helper: find which section a module key belongs to ────────────────────
function sectionOf(key: string, sections: NavSection[], modules: NavModule[]): string | null {
  const mod = modules.find(m => m.key === key);
  if (!mod) return null;
  return sections.find(s => s.groups.includes(mod.group))?.section ?? null;
}

// ── component ─────────────────────────────────────────────────────────────
export function NavDrawer({
  activeModule, onSelectModule,
  userEmail, userName, userPhotoUrl, onSignOut,
  modules, sections, groupIcons,
  collapsed, onToggleCollapsed,
  appKey = "tanda",
  appLabel = "Tangerine",
  logoText = "T",
  moduleParam = "m",
  headerSlot,
  toolsSlot,
  headerHeight = TOPBAR_H,
  userBoxHeight,
}: Props) {
  // Avatar shrinks to fit a fixed-height user box (DC's 64px-aligned top region).
  // Match the app-logo size (26) so the avatar and logo share the same icon
  // column — that's what lets the user name line up to the same left edge as
  // the app name (both = padding 8 + icon 26 + gap 10 = 44px).
  const avatarSz = 26;
  const { favorites, toggleFavorite, logClick } = usePersonalization();
  const modToMenuKey = useMemo<Record<string, string>>(() => {
    const re = new RegExp(`[?&]${moduleParam}=([^&]+)`);
    const out: Record<string, string> = {};
    for (const e of MENU_KEYS) {
      if (e.app !== appKey) continue;
      const m = (e.route || "").match(re);
      if (m) out[m[1]] = e.key;
    }
    return out;
  }, [appKey, moduleParam]);
  const menuKeyToMod = useMemo<Record<string, string>>(
    () => Object.fromEntries(Object.entries(modToMenuKey).map(([a, b]) => [b, a])),
    [modToMenuKey],
  );
  const [counts, setCounts]     = useState<Record<string, number>>(loadCounts);
  const [search, setSearch]     = useState("");
  const [userOpen, setUserOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // When a Favorite is clicked we navigate but DON'T auto-expand the module's
  // section in the menu below — the favorite IS the selection. This ref tells
  // the auto-open effect to skip the next activeModule change.
  const skipNextAutoOpen = useRef(false);
  // True while the active module was chosen from Favorites — its menu copy below
  // is then NOT highlighted (only the favorites row is). Any other activeModule
  // change (menu pick, drill-through, URL) clears it via the effect below.
  const [favSelected, setFavSelected] = useState(false);
  const favJustClicked = useRef(false);

  // ── accordion: open sections ───────────────────────────────────────────
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (activeModule) {
      const sec = sectionOf(activeModule, sections, modules);
      if (sec) initial.add(sec);
    }
    return initial;
  });

  // auto-open the section of the newly-active module — UNLESS the navigation
  // came from a Favorite click (then leave the menu sections as they are).
  useEffect(() => {
    if (!activeModule) return;
    if (skipNextAutoOpen.current) { skipNextAutoOpen.current = false; return; }
    const sec = sectionOf(activeModule, sections, modules);
    if (sec) setOpenSections(prev => prev.has(sec) ? prev : new Set([...prev, sec]));
  }, [activeModule, sections, modules]);

  const toggleSection = useCallback((name: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }, []);

  // cross-tab count sync
  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key === COUNTS_LS) setCounts(loadCounts()); };
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  }, []);

  const navigate = useCallback((key: string) => {
    setCounts(prev => bumpCount(key, prev));
    const mk = modToMenuKey[key];
    if (mk) logClick(mk);
    onSelectModule(key);
    setSearch("");
    setAppsOpen(false);
  }, [logClick, onSelectModule]);

  // Deep-link for a module so nav rows can be real <a> links — enables the
  // browser's native middle-click / Cmd-click / right-click → "Open in new tab".
  const moduleHref = (key: string) => `?m=${encodeURIComponent(key)}`;
  // Plain left-click → in-app navigation (no reload). Any modifier or middle
  // click falls through to the browser so it opens the href in a new TAB.
  const onNavClick = useCallback((e: React.MouseEvent, key: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
    e.preventDefault();
    e.stopPropagation();
    setFavSelected(false); // a real menu pick → menu highlight is back on
    navigate(key);
  }, [navigate]);

  // Right-click a nav row → open that same view in a NEW browser tab and focus
  // it. Left-click behavior is untouched. The app deep-links from ?m=<key> on
  // mount (see Tangerine.tsx), so the opened tab lands directly on that view.
  const RIGHT_CLICK_HINT = "Right-click: open in new tab";
  const onNavContext = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const url = new URL(moduleHref(key), window.location.href).toString();
    const win = window.open(url, "_blank");
    if (win) win.focus();
  }, []);

  // Favorites click — navigate, suppress the menu-section auto-open below, and
  // mark the selection favorites-driven so the menu copy isn't highlighted.
  // Only arm the skip when activeModule will actually change (so a re-click of
  // the current favorite doesn't leave a stale flag that swallows a later nav).
  const onFavClick = useCallback((e: React.MouseEvent, key: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (key !== activeModule) { skipNextAutoOpen.current = true; favJustClicked.current = true; }
    setFavSelected(true);
    navigate(key);
  }, [navigate, activeModule]);

  // Any activeModule change that DIDN'T come from a favorite click clears the
  // favorites-only highlight (menu picks, scorecard drill-throughs, URL loads).
  useEffect(() => {
    if (favJustClicked.current) { favJustClicked.current = false; return; }
    setFavSelected(false);
  }, [activeModule]);

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

  // Same modules, but split into the section's GROUPS (in declared order) so the
  // drawer can show a labelled sub-header per group (e.g. "CRM") instead of one
  // flat list. Empty groups are dropped; modules within a group are usage-sorted.
  const groupedModsIn = useCallback((s: NavSection): { group: string; mods: NavModule[] }[] =>
    s.groups
      .map(g => ({
        group: g,
        mods: modules.filter(m => m.group === g)
          .sort((a, b) => (counts[b.key] ?? 0) - (counts[a.key] ?? 0)),
      }))
      .filter(x => x.mods.length > 0),
    [modules, counts],
  );

  // ── favorites ─────────────────────────────────────────────────────────
  const favMods = useMemo(() =>
    favorites.map(mk => menuKeyToMod[mk]).filter(Boolean)
             .map(key => modules.find(m => m.key === key)).filter(Boolean) as NavModule[],
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

  // ── row style helpers ─────────────────────────────────────────────────
  // `active` is parameterized so the menu copy of a favorite-selected module can
  // render UN-highlighted (favSelected) while the favorites row stays highlighted.
  const rowStyle = (key: string, active: boolean = activeModule === key): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 8,
    padding: collapsed ? "7px 0" : "9px 10px 9px 22px",
    justifyContent: collapsed ? "center" : "flex-start",
    borderRadius: 5, cursor: "pointer", fontSize: 14,
    fontWeight: active ? 600 : 400,
    background: active ? C.bgActive : "transparent",
    color: active ? "#fff" : C.textMuted,
    userSelect: "none", whiteSpace: "nowrap", overflow: "hidden",
    transition: "background 0.1s",
  });
  const hoverOn  = (e: React.MouseEvent<HTMLElement>, key: string, active: boolean = activeModule === key) =>
    { (e.currentTarget as HTMLElement).style.background = active ? C.bgActive : C.bgRow; };
  const hoverOff = (e: React.MouseEvent<HTMLElement>, key: string, active: boolean = activeModule === key) =>
    { (e.currentTarget as HTMLElement).style.background = active ? C.bgActive : "transparent"; };
  // The active module as seen by the MENU sections (favorites-driven selection
  // doesn't light up its menu copy). Favorites rows still use activeModule.
  const menuActive = (key: string) => !favSelected && activeModule === key;

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
      {/* Header height pinned to TOPBAR_H so the app-name row lines up exactly
          with each app's slim notifications top bar (same 40px). */}
      <div style={{ display:"flex", alignItems:"center", gap:10, height:headerHeight, padding:"0 8px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        {collapsed ? (
          <button
            onClick={e => { e.stopPropagation(); onToggleCollapsed(); }}
            title="Expand menu"
            style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:15, padding:"3px 5px", lineHeight:1, flexShrink:0, borderRadius:4, width:"100%", textAlign:"center" }}
            onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
            onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
          >▶</button>
        ) : (
          <>
            <div
              onClick={e => { e.stopPropagation(); onSelectModule(null); }}
              title="Home"
              style={{ width:26, height:26, borderRadius:6, background:C.logo, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:13, color:"#fff", flexShrink:0, cursor:"pointer" }}
            >{logoText}</div>
            <span
              style={{ fontWeight:700, fontSize:14, letterSpacing:0.3, cursor:"pointer", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}
              onClick={e => { e.stopPropagation(); onSelectModule(null); }}
            >{appLabel}</span>
            <button
              onClick={e => { e.stopPropagation(); onToggleCollapsed(); }}
              title="Collapse menu"
              style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:15, padding:"3px 5px", lineHeight:1, flexShrink:0, borderRadius:4, marginLeft:"auto" }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
            >◀</button>
          </>
        )}
      </div>

      {/* App-specific header slot (e.g. notifications) — below the app name,
          above the user section. Hidden when collapsed. */}
      {!collapsed && headerSlot && (
        <div style={{ padding:"8px 10px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
          {headerSlot}
        </div>
      )}

      {/* ── User info (name only, no email) ───────────────────────── */}
      <div
        style={{ height: userBoxHeight, boxSizing: userBoxHeight ? "border-box" : undefined, padding: userBoxHeight ? (collapsed ? "0 4px" : "0 8px") : (collapsed ? "9px 4px" : "9px 8px"), borderBottom:`1px solid ${C.border}`, flexShrink:0, position:"relative", cursor: collapsed ? "default" : "pointer" }}
        onClick={e => { e.stopPropagation(); if (!collapsed) setUserOpen(v => !v); }}
      >
        <div style={{ display:"flex", alignItems:"center", gap:10, justifyContent: collapsed ? "center" : "flex-start" }}>
          {userPhotoUrl
            ? <img src={userPhotoUrl} alt={userName || ""} style={{ width:avatarSz, height:avatarSz, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
            : <span style={{ width:avatarSz, height:avatarSz, borderRadius:"50%", background:avBg, color:"#fff", fontSize:11, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{av}</span>
          }
          {!collapsed && (
            <>
              <span style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{userName || userEmail}</span>
              <span style={{ color:C.textMuted, fontSize:10, flexShrink:0 }}>{userOpen ? "▴" : "▾"}</span>
            </>
          )}
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
      <div style={{ padding: collapsed ? "7px 4px" : "7px 8px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        {collapsed ? (
          <button
            title="Search (expand to use)"
            onClick={e => { e.stopPropagation(); onToggleCollapsed(); setTimeout(() => searchRef.current?.focus(), 220); }}
            style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:15, width:"100%", textAlign:"center", lineHeight:1, padding:"3px 0" }}
          >Search</button>
        ) : (
          <input
            ref={searchRef}
            type="text" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") setSearch("");
              if (e.key === "Enter" && searchHits.length) { setFavSelected(false); navigate(searchHits[0].key); }
            }}
            placeholder="Search modules…"
            style={{ width:"100%", background:"#1e293b", border:"none", borderRadius:6, padding:"5px 10px", color:C.text, fontSize:13, outline:"none", boxSizing:"border-box" }}
          />
        )}
      </div>

      {/* ── Scrollable body ───────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:"auto", overflowX:"hidden" }}>

        {/* Search results */}
        {!collapsed && search && (
          <div style={{ padding:"4px" }}>
            {searchHits.length === 0
              ? <div style={{ color:C.textMuted, fontSize:12, padding:"8px 12px" }}>No matches</div>
              : searchHits.map(m => (
                <a key={m.key} href={moduleHref(m.key)} title={RIGHT_CLICK_HINT} style={{ ...rowStyle(m.key), textDecoration:"none" }}
                  onClick={e => onNavClick(e, m.key)}
                  onContextMenu={e => onNavContext(e, m.key)}
                  onMouseEnter={e => hoverOn(e, m.key)} onMouseLeave={e => hoverOff(e, m.key)}
                >
                  <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{m.label}</span>
                </a>
              ))
            }
          </div>
        )}

        {/* ── Favorites (always open) ── */}
        {!search && (
          <div style={{ padding:"0 4px" }}>
            {collapsed
              ? <div title="Favorites" style={{ textAlign:"center", padding:"9px 0 4px", color:C.star, fontSize:14 }}>★</div>
              : (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 10px 4px" }}>
                  <span style={{ fontSize:11, fontWeight:700, color:C.section, letterSpacing:0.9, textTransform:"uppercase" }}>Favorites</span>
                  {activeModule && (
                    <button
                      title={isActiveFav ? "Remove from favorites" : "Star this view"}
                      onClick={e => { e.stopPropagation(); const mk = modToMenuKey[activeModule ?? ""]; if (mk) void toggleFavorite(mk); }}
                      style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, color: isActiveFav ? C.star : C.textMuted, padding:0, lineHeight:1 }}
                    >{isActiveFav ? "★" : "☆"}</button>
                  )}
                </div>
              )
            }
            {!collapsed && favMods.length === 0 && (
              <div style={{ color:C.textMuted, fontSize:9.6, padding:"2px 10px 7px", fontStyle:"italic", opacity:0.6 }}>Use ☆ to star the current view</div>
            )}
            {favMods.map(m => (
              <a key={m.key} href={moduleHref(m.key)} style={{ ...rowStyle(m.key), textDecoration:"none" }} title={collapsed ? `${m.label} — ${RIGHT_CLICK_HINT}` : RIGHT_CLICK_HINT}
                onClick={e => onFavClick(e, m.key)}
                onContextMenu={e => onNavContext(e, m.key)}
                onMouseEnter={e => hoverOn(e, m.key)} onMouseLeave={e => hoverOff(e, m.key)}
              >
                {!collapsed && <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{m.label}</span>}
              </a>
            ))}
            <div style={{ height:1, background:C.border, margin:"5px 0" }} />
          </div>
        )}

        {/* ── Accordion module sections ── */}
        {!search && sortedSections.map(sec => {
          const mods = modsIn(sec);
          if (!mods.length) return null;
          const isOpen = openSections.has(sec.section);
          const hasActive = !favSelected && mods.some(m => m.key === activeModule);
          // Split into labelled groups; only show sub-headers when >1 group has
          // modules (single-group sections stay a clean flat list).
          const groups = groupedModsIn(sec);
          const showGroupHeaders = groups.length > 1;

          const renderRow = (m: NavModule) => (
            <a key={m.key} href={moduleHref(m.key)} title={RIGHT_CLICK_HINT} style={{ ...rowStyle(m.key, menuActive(m.key)), textDecoration:"none" }}
              onClick={e => onNavClick(e, m.key)}
              onContextMenu={e => onNavContext(e, m.key)}
              onMouseEnter={e => hoverOn(e, m.key, menuActive(m.key))} onMouseLeave={e => hoverOff(e, m.key, menuActive(m.key))}
            >
              <span style={{ overflow:"hidden", textOverflow:"ellipsis", flex:1 }}>{m.label}</span>
              {(counts[m.key] ?? 0) > 0 && (
                <span style={{ fontSize:10, color:C.textMuted, flexShrink:0 }}>{counts[m.key]}</span>
              )}
            </a>
          );

          return (
            <div key={sec.section} style={{ padding:"0 4px" }}>
              {/* Section header — clickable to toggle */}
              <div
                onClick={e => { e.stopPropagation(); if (!collapsed) toggleSection(sec.section); }}
                title={collapsed ? sec.section : undefined}
                style={{
                  display:"flex", alignItems:"center",
                  justifyContent: collapsed ? "center" : "space-between",
                  padding: collapsed ? "8px 0" : "7px 10px",
                  cursor:"pointer", borderRadius:5, userSelect:"none",
                  background: hasActive && !isOpen ? "rgba(29,78,216,0.15)" : "transparent",
                  transition:"background 0.1s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = hasActive && !isOpen ? "rgba(29,78,216,0.2)" : C.bgRow; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = hasActive && !isOpen ? "rgba(29,78,216,0.15)" : "transparent"; }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  {!collapsed && (
                    <span style={{ fontSize:13, fontWeight:600, color: hasActive ? C.text : C.textMuted, letterSpacing:0.5, textTransform:"uppercase", whiteSpace:"nowrap" }}>
                      {sec.section}
                    </span>
                  )}
                </div>
                {!collapsed && (
                  <span style={{ color:C.textMuted, fontSize:10, flexShrink:0 }}>{isOpen ? "▴" : "▾"}</span>
                )}
              </div>

              {/* Sub-items — only rendered when section is open. When the
                  section spans multiple groups, each group gets a small label
                  header (e.g. CRM) so the taxonomy is visible; otherwise it's a
                  flat list. */}
              {!collapsed && isOpen && !showGroupHeaders && mods.map(renderRow)}
              {!collapsed && isOpen && showGroupHeaders && groups.map((g, gi) => (
                <div key={g.group}>
                  {/* Skip the group header when it duplicates the section name
                      (the duplicate "header again on expand" the operator flagged). */}
                  {g.group !== sec.section && (
                    <div style={{
                      display:"flex", alignItems:"center", gap:6,
                      padding:"6px 10px 3px", marginTop: gi === 0 ? 0 : 4,
                      borderTop: gi === 0 ? "none" : `1px solid ${C.border}`,
                    }}>
                      <span style={{ fontSize:11, fontWeight:700, color:C.textMuted, letterSpacing:0.6, textTransform:"uppercase", whiteSpace:"nowrap" }}>
                        {g.group}
                      </span>
                    </div>
                  )}
                  {g.mods.map(renderRow)}
                </div>
              ))}

              {/* In collapsed mode show active item's icon always */}
              {collapsed && hasActive && (
                <div style={rowStyle(activeModule!)} title={modules.find(m => m.key === activeModule)?.label ?? ""}>
                  <span style={{ fontSize:14 }}>{modules.find(m => m.key === activeModule)?.label?.slice(0, 2)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── App tools (optional, app-specific) ────────────────────── */}
      {/* e.g. Design Calendar's List/Grid · Activity · Settings, moved off the
          top bar into the drawer. Hidden when collapsed. */}
      {!collapsed && toolsSlot && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"6px 8px", flexShrink:0, display:"flex", flexDirection:"column", gap:6 }}>
          {toolsSlot}
        </div>
      )}

      {/* ── Apps switcher at bottom ───────────────────────────────── */}
      <div style={{ borderTop:`1px solid ${C.border}`, padding:"4px 4px", flexShrink:0, position:"relative" }}>
        <button
          onClick={e => { e.stopPropagation(); setAppsOpen(v => !v); }}
          title="Switch app"
          style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background: appsOpen ? C.bgRow : "none", border:"none", color: appsOpen ? C.text : C.textMuted, cursor:"pointer", borderRadius:5, padding: collapsed ? "7px 0" : "6px 10px", fontSize:13, justifyContent: collapsed ? "center" : "flex-start", transition:"background 0.1s" }}
          onMouseEnter={e => { e.currentTarget.style.background = C.bgRow; e.currentTarget.style.color = C.text; }}
          onMouseLeave={e => { if (!appsOpen) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; } }}
        >
          {collapsed ? <span style={{ fontSize:13, fontWeight:700 }}>···</span> : <span>All Apps</span>}
        </button>

        {appsOpen && (
          <>
            <div onClick={e => { e.stopPropagation(); setAppsOpen(false); }} style={{ position:"fixed", inset:0, zIndex:290 }} aria-hidden />
            <div
              style={{ position:"fixed", bottom:8, left:w+8, width:"min(310px, 95vw)", maxHeight:"90vh", overflowY:"auto", boxSizing:"border-box", background:"#1e293b", border:`1px solid ${C.border}`, borderRadius:10, padding:10, zIndex:300, boxShadow:"0 10px 30px rgba(0,0,0,0.5)" }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize:11, color:C.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:8, padding:"0 4px" }}>Suite Apps</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                {SUITE_APPS.map(a => (
                  <a key={a.href} href={a.href} target="_blank" rel="noreferrer"
                    style={{ display:"flex", alignItems:"center", gap:7, padding:"6px 8px", borderRadius:7, textDecoration:"none", color:C.text, background:"transparent", transition:"background 0.12s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                    title={a.description}
                  >
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
