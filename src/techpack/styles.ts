// Style sheet for the TechPack app. Originally inline at the bottom
// of TechPack.tsx — moved here so future panel splits can import the
// same canonical token set without round-tripping through the 4k-line
// monolith. Same shape (`Record<string, React.CSSProperties>`) so the
// `S.xxx` lookup pattern in the main component stays unchanged.

import type React from "react";

const S: Record<string, React.CSSProperties> = {
  app:          { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },

  // Nav
  nav:          { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:      { display: "flex", alignItems: "center", gap: 12 },
  navLogo:      { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16 },
  navTitle:     { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:       { fontSize: 12, color: "#6B7280" },
  navRight:     { display: "flex", alignItems: "center", gap: 8 },
  navBtn:       { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  navBtnActive: { background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" },
  navBtnDanger: { background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },

  // Content
  content:      { maxWidth: "90%", margin: "0 auto", padding: "24px 20px" },
  statsRow:     { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 },
  statCard:     { background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 6 },
  card:         { background: "#1E293B", borderRadius: 12, padding: 20, marginBottom: 20 },
  cardTitle:    { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#F1F5F9" },

  // Tech Pack Card
  tpCard:       { background: "#1E293B", borderRadius: 12, padding: 16, border: "1px solid #334155", cursor: "pointer", transition: "border-color 0.15s, transform 0.15s" },

  // Filters
  filters:      { display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" as any },

  // PO Row / list item
  poRow:        { display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", borderRadius: 8, marginBottom: 8, background: "#0F172A", cursor: "pointer", transition: "background .15s" },
  badge:        { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 },

  // Empty state
  emptyState:   { textAlign: "center", padding: 40, color: "#6B7280", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },

  // Forms
  input:        { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  select:       { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" },
  textarea:     { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, resize: "vertical" as any, outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  label:        { color: "#94A3B8", fontSize: 13, display: "block", marginBottom: 4 },

  // Buttons
  btnPrimary:      { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" },
  btnPrimarySmall: { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSecondary:    { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSmall:        { background: "#334155", color: "#D1D5DB", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 },
  iconBtn:         { background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 4, lineHeight: 1 },
  iconBtnTiny:     { background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 2, lineHeight: 1, color: "#6B7280" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#1E293B", borderRadius: 16, width: 520, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:   { margin: 0, fontSize: 18, fontWeight: 700, color: "#F1F5F9" },
  modalBody:    { padding: 20, overflowY: "auto" },
  closeBtn:     { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" },

  // Detail panel
  detailOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  detailPanel:   { background: "#1E293B", width: 780, maxWidth: "95vw", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" },
  detailHeader:  { padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#0F172A" },
  detailPONum:   { fontFamily: "monospace", color: "#60A5FA", fontWeight: 800, fontSize: 20 },
  detailVendor:  { color: "#D1D5DB", fontWeight: 600, fontSize: 15, marginTop: 4 },

  // Info grid
  infoGrid:      { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 },
  infoCell:      { background: "#0F172A", borderRadius: 8, padding: 12 },
  infoCellLabel: { color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  infoCellValue: { color: "#F1F5F9", fontSize: 14, fontWeight: 600 },

  // Tables
  table:        { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:           { padding: "10px 8px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", background: "#1E293B", whiteSpace: "nowrap" },
  td:           { padding: "8px", borderBottom: "1px solid #1E293B", color: "#D1D5DB", verticalAlign: "middle" },
  cellInput:    { background: "transparent", border: "1px solid transparent", borderRadius: 4, padding: "4px 6px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },

  // Table wrap for non-HTML tables
  tableWrap:    { background: "#1E293B", borderRadius: 12, overflow: "hidden", border: "1px solid #334155" },
  tableHeader:  { display: "flex", padding: "12px 16px", background: "#0F172A", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, gap: 12, borderBottom: "1px solid #334155", fontWeight: 600 },
  tableRow:     { display: "flex", padding: "10px 16px", gap: 12, fontSize: 13, alignItems: "center", borderBottom: "1px solid #1E293B" },
};

export default S;
