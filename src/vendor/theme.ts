// Vendor-portal theme — dark palette to match the ROF-side PhaseReviews page.
// Same keys as src/utils/theme TH so existing vendor components can swap their
// import path without changing a single style reference.
export const TH = {
  bg: "#0F172A",              // slate-900 — app background
  surface: "#1E293B",         // slate-800 — cards, table rows
  surfaceHi: "#334155",       // slate-700 — table headers, hover rows
  border: "#334155",          // slate-700 — all 1px borders
  header: "#0B1220",          // slate-950 — top nav bar
  primary: "#3B82F6",         // blue-500 — primary actions + links
  primaryLt: "#60A5FA",       // blue-400
  text: "#F1F5F9",            // slate-100 — main body text
  textSub: "#CBD5E1",         // slate-300 — secondary labels
  textSub2: "#94A3B8",        // slate-400 — tertiary labels
  textMuted: "#64748B",       // slate-500 — placeholder / disabled
  accent: "#1E3A8A22",        // blue-900 @ 13% — tint backgrounds
  accentBdr: "#3B82F655",     // primary @ 33% — tint borders
  shadow: "rgba(0,0,0,0.4)",
  shadowMd: "rgba(0,0,0,0.55)",
};
