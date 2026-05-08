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
  content:     { maxWidth: 1600, margin: "0 auto", padding: "20px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const, width: "100%", boxSizing: "border-box" as const },
  statsRow:    { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16, flexShrink: 0 },
  statCard:    { background: "#1E293B", borderRadius: 10, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 },
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
  // Row divider drawn as `box-shadow: inset 0 -1px 0` instead of a
  // real `borderBottom`. Reason: the body cells use position:sticky +
  // overflow:hidden + box-sizing:border-box on the leading 8 columns
  // (S.stickyCol). In that combination Chrome/Edge intermittently
  // drop the painted borderBottom on sticky cells during horizontal
  // scroll — lines flicker / disappear and rows visually merge. The
  // inset shadow paints inside the layout box, on top of the
  // background, so neither overflow clipping nor sticky stacking can
  // hide it. Visually identical to a 1px borderBottom at #475569
  // (slate-600), which reads cleanly against the #0F172A row bg.
  // borderRight stays as a real border because vertical separators
  // weren't affected by the bug.
  td:          { padding: "7px 10px", boxShadow: "inset 0 -1px 0 0 #475569", borderRight: "1px solid #64748B", whiteSpace: "nowrap" as const, verticalAlign: "middle" as const },
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
