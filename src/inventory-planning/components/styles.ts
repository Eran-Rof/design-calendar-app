// Shared styles for the planning UI. Aligned with the ATS app's
// `TH` palette (src/utils/theme.ts) — light surface, slate-on-white
// text, ROF-red brand gradient, soft drop-shadow on cards. The PAL
// keys stay the same so the existing 175+ call sites need no
// changes; only the values shift.

import type React from "react";

export const PAL = {
  // Page background — slate-gray matching ATS's TH.bg so cards "lift".
  bg:       "#4A5568",
  // Card / panel surface — white, same as ATS TH.surface.
  panel:    "#FFFFFF",
  panelAlt: "#F7F8FA",
  border:   "#CBD5E0",
  borderFaint: "#E2E8F0",
  text:     "#1A202C",
  textDim:  "#4A5568",
  textMuted:"#718096",
  // ROF brand red — primary accent for buttons, links, action chips.
  accent:   "#C8210A",
  accent2:  "#E02B10",
  green:    "#0E9F6E",
  yellow:   "#B45309",
  red:      "#C8210A",
  chipBg:   "#EDF2F7",
};

// Shared shadow tokens to keep cards/drawers consistent with ATS.
const SHADOW_CARD = "0 2px 8px rgba(0,0,0,0.12)";
const SHADOW_LG   = "0 8px 24px rgba(0,0,0,0.18)";

export const S: Record<string, React.CSSProperties> = {
  app:        { minHeight: "100vh", background: PAL.bg, color: PAL.text, fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  content:    { maxWidth: 1600, margin: "0 auto", padding: "20px" },
  nav:        { background: PAL.panel, borderBottom: `1px solid ${PAL.border}`, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100, boxShadow: SHADOW_CARD },
  navLeft:    { display: "flex", alignItems: "center", gap: 12 },
  navLogo:    { width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${PAL.accent}, ${PAL.accent2})`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13 },
  navTitle:   { fontWeight: 700, fontSize: 16, color: PAL.text },
  navSub:     { fontSize: 12, color: PAL.textMuted },
  navRight:   { display: "flex", alignItems: "center", gap: 8 },
  btnPrimary: { background: `linear-gradient(135deg, ${PAL.accent}, ${PAL.accent2})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnSecondary:{ background: PAL.panel, border: `1px solid ${PAL.border}`, color: PAL.textDim, borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer" },
  btnGhost:   { background: "transparent", border: "none", color: PAL.textDim, padding: "6px 8px", cursor: "pointer", fontSize: 13 },
  card:       { background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 12, padding: "18px 20px", marginBottom: 16, boxShadow: SHADOW_CARD },
  cardTitle:  { margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: PAL.text },
  statsRow:   { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 16 },
  statCard:   { background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, boxShadow: SHADOW_CARD },
  toolbar:    { display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" },
  // colorScheme: "light" makes the browser render its native widgets
  // (date/month picker, scrollbars) for the now-light surface so the
  // calendar glyph stays visible on white inputs.
  input:      { background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: "9px 13px", color: PAL.text, fontSize: 13, outline: "none", boxSizing: "border-box", colorScheme: "light" },
  select:     { background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: "9px 13px", color: PAL.text, fontSize: 13, outline: "none", colorScheme: "light" },
  label:      { color: PAL.textMuted, fontSize: 10, letterSpacing: "0.12em", fontWeight: 600, textTransform: "uppercase" as const, display: "block", marginBottom: 5 },
  tableWrap:  { overflow: "auto", maxHeight: "calc(100vh - 260px)", borderRadius: 12, border: `1px solid ${PAL.border}`, background: PAL.panel, boxShadow: SHADOW_CARD },
  table:      { borderCollapse: "separate" as const, borderSpacing: 0, width: "100%", fontSize: 12 },
  th:         { background: PAL.panelAlt, color: PAL.textMuted, fontWeight: 600, fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "8px 10px", borderBottom: `1px solid ${PAL.border}`, borderRight: `1px solid ${PAL.borderFaint}`, whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0, zIndex: 2, textAlign: "left" as const },
  td:         { padding: "6px 10px", borderBottom: `1px solid ${PAL.borderFaint}`, borderRight: `1px solid ${PAL.borderFaint}`, whiteSpace: "nowrap" as const, verticalAlign: "middle" as const },
  tdNum:      { padding: "6px 10px", borderBottom: `1px solid ${PAL.borderFaint}`, borderRight: `1px solid ${PAL.borderFaint}`, whiteSpace: "nowrap" as const, textAlign: "right" as const, fontFamily: "monospace" },
  chip:       { display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 },
  drawerOverlay:{ position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.45)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  drawer:     { background: PAL.panel, width: 520, maxWidth: "90vw", height: "100%", overflowY: "auto" as const, display: "flex", flexDirection: "column" as const, borderLeft: `1px solid ${PAL.border}`, boxShadow: SHADOW_LG },
  drawerHeader:{ padding: "16px 20px", borderBottom: `1px solid ${PAL.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: PAL.panelAlt },
  drawerBody: { padding: 20, flex: 1 },
  infoCell:   { background: PAL.panelAlt, border: `1px solid ${PAL.borderFaint}`, borderRadius: 8, padding: 12 },
  infoLabel:  { color: PAL.textMuted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4 },
  infoValue:  { color: PAL.text, fontSize: 14, fontWeight: 600 },
};

// Action / confidence color maps — centralized so chips are consistent.
export const ACTION_COLOR: Record<string, string> = {
  buy:      PAL.accent,
  expedite: PAL.red,
  reduce:   PAL.yellow,
  hold:     PAL.textMuted,
  monitor:  PAL.textDim,
};

export const CONFIDENCE_COLOR: Record<string, string> = {
  committed: PAL.green,
  probable:  PAL.accent,
  possible:  PAL.yellow,
  estimate:  PAL.textMuted,
};

export const METHOD_COLOR: Record<string, string> = {
  ly_sales:                    PAL.accent2,
  trailing_avg_sku:            PAL.accent,
  weighted_recent_sku:         PAL.green,
  cadence_sku:                 PAL.yellow,
  category_fallback:           PAL.textDim,
  customer_category_fallback:  PAL.textMuted,
  zero_floor:                  PAL.textMuted,
};

export const METHOD_LABEL: Record<string, string> = {
  ly_sales:                    "Same Period LY",
  trailing_avg_sku:            "Trailing",
  weighted_recent_sku:         "Weighted",
  cadence_sku:                 "Cadence",
  category_fallback:           "Cat. FB",
  customer_category_fallback:  "Cust. FB",
  zero_floor:                  "Zero",
};

export function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return Math.round(n).toLocaleString();
}

// ── Date formatting ────────────────────────────────────────────────────────
// House format is MMM/DD/YYYY (e.g. Apr/19/2026) everywhere planning data
// is shown. ISO strings are parsed as UTC to keep month boundaries stable.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-04-19" or "2026-04-19T12:34:56Z" → "Apr/19/2026". Returns "–" on null/invalid.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  // Fast path for YYYY-MM-DD — avoids TZ foot-guns.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    const [, y, mm, dd] = m;
    const mi = Number(mm) - 1;
    if (mi < 0 || mi > 11) return "–";
    return `${MONTHS[mi]}/${dd}/${y}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return `${MONTHS[d.getUTCMonth()]}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

// Timestamp with local time for audit trails. Returns e.g. "Apr/19/2026 14:32".
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const date = `${MONTHS[d.getMonth()]}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mi}`;
}

// "2026-04" period code → "Apr 2026".
export function formatPeriodCode(code: string | null | undefined): string {
  if (!code) return "–";
  const m = /^(\d{4})-(\d{2})$/.exec(code);
  if (!m) return code;
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return code;
  return `${MONTHS[mi]} ${m[1]}`;
}
