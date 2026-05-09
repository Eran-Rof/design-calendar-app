import type React from "react";

const S: Record<string, React.CSSProperties> = {
  // Viewport-locked column layout. Without this, the page scrolls
  // independently of the table, which pushes the table's horizontal
  // scrollbar (rendered at the bottom of the table's own scroll area)
  // below the viewport until the user manually scrolls down. With the
  // app locked to 100vh and the table flexing into the remaining
  // space, the horizontal bar is always visible at the page bottom.
  app:         { height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column" as const, background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  nav:         { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:     { display: "flex", alignItems: "center", gap: 12 },
  navLogo:     { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#10B981,#3B82F6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: "-0.5px" },
  navTitle:    { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:      { fontSize: 12, color: "#6B7280" },
  navRight:    { display: "flex", alignItems: "center", gap: 8 },
  navBtn:      { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center" },
  navBtnPrimary: { background: "linear-gradient(135deg,#10B981,#3B82F6)", border: "none", color: "#fff", borderRadius: 6, padding: "5px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600 },
  demoBanner:  { background: "#78350F", color: "#FCD34D", padding: "8px 24px", fontSize: 13 },
  // flex:1 inside the viewport-locked S.app makes content fill the
  // remaining space below the navbar/banners. minHeight:0 is the
  // standard flex-child override that lets the inner table actually
  // shrink + scroll instead of forcing the parent to grow.
  // Top padding 15 (was 20) trims the gap between the unmatched-banner
  // and the stat cards by 25% per operator request. Sides + bottom
  // stay at 20 so the body grid keeps its breathing room.
  content:     { maxWidth: 1600, margin: "0 auto", padding: "15px 20px 20px 20px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const, width: "100%", boxSizing: "border-box" as const },
  statsRow:    { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16, flexShrink: 0 },
  // Card height ~25% smaller: vertical padding 16→10, internal gap
  // 4→2, plus matching font-size trims in StatCard.tsx (value 22→18,
  // label 11→10) so the slimmer card doesn't crop the value.
  statCard:    { background: "#1E293B", borderRadius: 10, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 2 },
  toolbar:     { display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap", flexShrink: 0 },
  searchInput: { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", width: 240, boxSizing: "border-box" as const },
  select:      { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", color: "#F1F5F9", fontSize: 13, outline: "none", cursor: "pointer" },
  datePicker:  { display: "flex", alignItems: "center", gap: 6 },
  dateLabel:   { fontSize: 12, color: "#6B7280", whiteSpace: "nowrap" as const },
  dateInput:   { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", color: "#F1F5F9", fontSize: 13, outline: "none" },
  legend:      { display: "flex", gap: 16, marginBottom: 10, alignItems: "center", flexWrap: "wrap" as const },
  legendItem:  { display: "flex", alignItems: "center", gap: 5 },
  // overflowX: "scroll" (not "auto") forces the horizontal scrollbar to
  // be drawn even when the content fits. flex:1 + minHeight:0 lets the
  // wrapper grow into the remaining viewport space below the toolbar
  // — combined with S.app's viewport lock, the horizontal bar is
  // pinned to the bottom of the visible area.
  tableWrap:   { overflowX: "scroll" as const, overflowY: "auto" as const, flex: 1, minHeight: 0, borderRadius: 10, border: "1px solid #334155", background: "#0F172A" },
  table:       { borderCollapse: "separate" as const, borderSpacing: 0, width: "100%", fontSize: 13 },
  th:          { background: "#1E293B", color: "#6B7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "10px 12px", borderBottom: "1px solid #334155", borderRight: "1px solid #2D3748", whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0, zIndex: 2 },
  // Row divider color bumped to slate-500 #64748B to match the
  // existing vertical borderRight. The previous slate-600 #475569
  // was rendering reliably enough on frozen sticky cells but reading
  // as nearly-absent in the non-freeze view — just below the
  // monitor's contrast threshold for some operators. Matching the
  // verticals also makes the grid look uniform.
  //
  // Drawn THREE ways at once for redundancy: real borderBottom +
  // box-shadow inset (paints inside the layout box) + box-shadow
  // outset (paints into the next row's top edge so any cell-seam
  // gap is filled). The CSS rule injected from GridTable.tsx adds
  // a fourth (gradient background-image) and a fifth (::after
  // pseudo-element) — together they survive any single Chrome
  // compositor cull on sticky cells under horizontal scroll.
  td:          {
    padding: "7px 10px",
    // 2px-tall divider (was 1px) so Chrome's compositor can't sub-
    // pixel-cull it during sticky-cell scroll. The On Hand / On Order
    // / On PO columns are mid-sticky (cols 6-8 of 8) and were the
    // most reliable place for the cull to happen. 2px lines stay
    // visible even when the renderer drops a row of sub-pixels.
    borderBottom: "2px solid #64748B",
    boxShadow: "inset 0 -2px 0 0 #64748B, 0 2px 0 0 #64748B",
    borderRight: "1px solid #64748B",
    whiteSpace: "nowrap" as const,
    verticalAlign: "middle" as const,
  },
  // overflow:hidden + textOverflow:ellipsis clip cell content at the
  // right edge so longer-than-the-column-width text (e.g. "Cream Tonal
  // Grizzly Camo") can't bleed into the next column and visually
  // erase its left border. boxSizing:border-box keeps the border
  // INSIDE the declared width so columns line up to their stated
  // pixel offsets.
  stickyCol:   { position: "sticky" as const, zIndex: 2, borderRight: "1px solid #64748B", overflow: "hidden" as const, textOverflow: "ellipsis" as const, boxSizing: "border-box" as const },
  loadingState:{ textAlign: "center" as const, padding: 60, color: "#6B7280", background: "#1E293B", borderRadius: 10 },
  emptyState:  { textAlign: "center" as const, padding: 60, color: "#6B7280", background: "#1E293B", borderRadius: 10 },
  modalOverlay:{ position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.75)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:       { background: "#1E293B", borderRadius: 14, width: 500, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" as const, border: "1px solid #334155" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:  { margin: 0, fontSize: 17, fontWeight: 700, color: "#F1F5F9" },
  modalBody:   { padding: 20, overflowY: "auto" as const },
  closeBtn:    { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1 },
  dropZone:    { border: "2px dashed #334155", borderRadius: 10, padding: "32px 20px", textAlign: "center" as const, cursor: "pointer", transition: "border-color 0.2s" },
};

export default S;
