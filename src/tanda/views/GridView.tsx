import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import XLSXStyle from "xlsx-js-style";
import {
  type XoroPO, type Milestone, type View,
  MILESTONE_STATUS_COLORS, MILESTONE_STATUSES, fmtDate,
} from "../../utils/tandaTypes";
import S from "../styles";
import { GridPOPanel } from "./GridPOPanel";
import { MilestoneDateInput } from "../detail/MilestoneDateInput";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { useTandaStore } from "../store/index";

const PAGE_SIZE = 16;
const MAX_UNDO  = 30;

// Fixed column widths: expand | notes | PO# | Vendor | Buyer | BuyerPO | DDP | Days from DDP
const FIXED_COLS = "32px 32px 130px 160px 140px 110px 90px 72px";
// Per-phase sub-columns sized to fit content + ~2-char breathing room:
//   Due Date 70 | Status ("Not Started") 90 | Status Date 82 | Days ("365 late") 56 | Phase Notes 26
const PHASE_SUB  = "70px 90px 82px 56px 26px";
const PHASE_COLS = 5;

// Border constants
const B_CELL   = "2px solid #1E293B";   // standard cell border (H and V)
const B_INNER  = "2px solid #0F172A";   // darker inner top-of-row divider
const B_HDR    = "2px solid #334155";   // header borders
const B_PHASE  = "4px solid #334155";   // thick divider between phase groups

function buildColTpl(phaseCount: number) {
  return phaseCount > 0
    ? `${FIXED_COLS} ${Array(phaseCount).fill(PHASE_SUB).join(" ")}`
    : FIXED_COLS;
}

// ── NotesModal ─────────────────────────────────────────────────────────────
// Separate component so it can own its own state (noteText, addPhase).
interface NotesModalProps {
  po: XoroPO;
  ms: Milestone[];           // live milestone list (optimistically updated)
  filterPhase?: string;      // if set, scopes display + add-target to one phase
  onClose: () => void;
  onAddNote: (m: Milestone, text: string) => void;
}
function NotesModal({ po, ms, filterPhase, onClose, onAddNote }: NotesModalProps) {
  const [noteText, setNoteText] = useState("");
  const [addPhase, setAddPhase] = useState(filterPhase ?? "");

  // Milestones selectable for adding a note
  const availableMs = filterPhase ? ms.filter(m => m.phase === filterPhase) : ms;

  // Set initial addPhase once
  useEffect(() => {
    if (!addPhase && availableMs.length > 0) setAddPhase(availableMs[0].phase);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notes to display
  const shown = filterPhase
    ? ms.filter(m => m.phase === filterPhase && ((m.note_entries && m.note_entries.length > 0) || m.notes))
    : ms.filter(m => (m.note_entries && m.note_entries.length > 0) || m.notes);

  const handleAdd = () => {
    if (!noteText.trim()) return;
    const target = availableMs.find(m => m.phase === addPhase) ?? availableMs[0];
    if (!target) return;
    onAddNote(target, noteText.trim());
    setNoteText("");
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: 560, maxHeight: "75vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>
              {po.PoNumber}
              {filterPhase && <span style={{ marginLeft: 10, color: "#C4B5FD", fontFamily: "sans-serif", fontSize: 12, fontWeight: 400 }}>· {filterPhase}</span>}
            </div>
            <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>
              {filterPhase ? "Phase Notes" : "All Milestone Notes"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {/* Existing notes — scrollable */}
        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {shown.length === 0 ? (
            <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
              No notes yet — add one below.
            </div>
          ) : (
            shown.map(m => (
              <div key={m.id} style={{ marginBottom: 18 }}>
                {!filterPhase && (
                  <div style={{ color: "#C4B5FD", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>
                    {m.phase}
                    <span style={{ marginLeft: 8, color: "#6B7280", fontWeight: 400, textTransform: "none", fontSize: 10 }}>{m.category}</span>
                  </div>
                )}
                {m.note_entries && m.note_entries.length > 0
                  ? m.note_entries.map((ne, i) => (
                      <div key={i} style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px", marginBottom: 6 }}>
                        <div style={{ color: "#E5E7EB", fontSize: 12 }}>{ne.text}</div>
                        <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>{ne.user} · {ne.date}</div>
                      </div>
                    ))
                  : m.notes
                    ? <div style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px" }}>
                        <div style={{ color: "#E5E7EB", fontSize: 12 }}>{m.notes}</div>
                      </div>
                    : null}
              </div>
            ))
          )}
        </div>

        {/* Add note footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #1E293B", flexShrink: 0, background: "#080F1A", borderRadius: "0 0 10px 10px" }}>
          {!filterPhase && availableMs.length > 1 && (
            <select
              value={addPhase}
              onChange={e => setAddPhase(e.target.value)}
              style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 11, padding: "5px 8px", marginBottom: 8, boxSizing: "border-box", outline: "none" }}
            >
              {availableMs.map(m => <option key={m.id} value={m.phase}>{m.phase}</option>)}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={filterPhase ? `Add note for ${filterPhase}…` : "Add a note…"}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
              style={{ flex: 1, background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: "#E5E7EB", fontSize: 12, padding: "8px 10px", resize: "none", height: 60, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
            />
            <button
              onClick={handleAdd}
              disabled={!noteText.trim()}
              style={{ background: noteText.trim() ? "#3B82F6" : "#1A2535", border: "none", borderRadius: 6, color: noteText.trim() ? "#fff" : "#374151", fontSize: 12, padding: "0 16px", cursor: noteText.trim() ? "pointer" : "default", fontWeight: 600, flexShrink: 0, transition: "background 0.15s" }}
            >
              Add
            </button>
          </div>
          <div style={{ color: "#374151", fontSize: 10, marginTop: 5 }}>Enter to submit · Shift+Enter for new line</div>
        </div>
      </div>
    </div>
  );
}

// ── GridView ───────────────────────────────────────────────────────────────
interface GridViewProps {
  pos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  buyers: string[];
  vendors: string[];
  setView: (v: View) => void;
  setSelected: (po: XoroPO | null) => void;
  setDetailMode: (m: any) => void;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => void;
  ensureMilestones: (po: XoroPO) => Promise<Milestone[] | "needs_template"> | void;
  vendorHasTemplate: (vendorName: string) => boolean;
  user: { name?: string } | null;
}

export function GridView({
  pos, milestones, buyers, vendors, setView, setSelected, setDetailMode,
  saveMilestone, ensureMilestones, vendorHasTemplate, user,
}: GridViewProps) {

  // Inject scrollbar CSS once — always-visible horizontal bar in dark-theme colors.
  useEffect(() => {
    const id = "gv-scrollbar-style";
    if (document.getElementById(id)) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = `
      .gv-scroll { overflow-x: scroll; overflow-y: auto; }
      .gv-scroll::-webkit-scrollbar { height: 8px; width: 8px; }
      .gv-scroll::-webkit-scrollbar-track { background: #0F172A; border-top: 1px solid #1E293B; }
      .gv-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .gv-scroll::-webkit-scrollbar-thumb:hover { background: #475569; }
      .gv-scroll::-webkit-scrollbar-corner { background: #0F172A; }
    `;
    document.head.appendChild(el);
  }, []);

  const [search, setSearch]                 = useState("");
  const [filterVendor, setFilterVendor]     = useState("All");
  const [filterBuyer, setFilterBuyer]       = useState("All");
  const [expandedPo, setExpandedPo]         = useState<XoroPO | null>(null);
  const [buyerPoEditing, setBuyerPoEditing] = useState<string | null>(null);
  const [buyerPoDraft, setBuyerPoDraft]     = useState("");
  const [page, setPage]                     = useState(0);
  const [undoStack, setUndoStack]           = useState<Milestone[]>([]);
  const [notesModal, setNotesModal]         = useState<{
    po: XoroPO; ms: Milestone[]; filterPhase?: string;
  } | null>(null);

  const ensureAttemptedRef = useRef<Set<string>>(new Set());

  // ── Rows ────────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const s = search.toLowerCase();
    return pos.filter(p => {
      if (filterVendor !== "All" && (p.VendorName ?? "") !== filterVendor) return false;
      if (filterBuyer  !== "All" && (p.BuyerName  ?? "") !== filterBuyer)  return false;
      if (!s) return true;
      return (
        (p.PoNumber   ?? "").toLowerCase().includes(s) ||
        (p.VendorName ?? "").toLowerCase().includes(s) ||
        (p.BuyerName  ?? "").toLowerCase().includes(s) ||
        (p.BuyerPo    ?? "").toLowerCase().includes(s)
      );
    });
  }, [pos, search, filterVendor, filterBuyer]);

  useEffect(() => setPage(0), [search, filterVendor, filterBuyer]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasActiveFilter = search.trim() !== "" || filterVendor !== "All" || filterBuyer !== "All";
  useEffect(() => {
    if (!ensureMilestones || !hasActiveFilter) return;
    for (const po of rows) {
      const poNum = po.PoNumber ?? "";
      if (!poNum) continue;
      if ((milestones[poNum] || []).length > 0) continue;
      if (ensureAttemptedRef.current.has(poNum)) continue;
      if (!po.DateExpectedDelivery) continue;
      if (po.VendorName && !vendorHasTemplate(po.VendorName)) continue;
      ensureAttemptedRef.current.add(poNum);
      void ensureMilestones(po);
    }
  }, [rows, milestones, ensureMilestones, vendorHasTemplate, hasActiveFilter]);

  const phases = useMemo(() => {
    const order = new Map<string, number>();
    rows.forEach(p => {
      (milestones[p.PoNumber ?? ""] || []).forEach(m => {
        const cur = order.get(m.phase);
        if (cur === undefined || m.sort_order < cur) order.set(m.phase, m.sort_order);
      });
    });
    return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([phase]) => phase);
  }, [rows, milestones]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const pushUndo = useCallback((old: Milestone) => {
    setUndoStack(s => [old, ...s].slice(0, MAX_UNDO));
  }, []);

  const updateStatus = (po: XoroPO, m: Milestone, newStatus: string) => {
    pushUndo(m);
    const dates = { ...(m.status_dates || {}) };
    const iso   = new Date().toISOString().split("T")[0];
    if (newStatus !== "Not Started" && !dates[newStatus]) dates[newStatus] = iso;
    saveMilestone({
      ...m,
      status: newStatus,
      status_date: dates[newStatus] || null,
      status_dates: Object.keys(dates).length > 0 ? dates : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    }, true);
  };

  const updateField = useCallback((m: Milestone, patch: Partial<Milestone>) => {
    pushUndo(m);
    saveMilestone({ ...m, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
  }, [pushUndo, saveMilestone, user]);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const [prev, ...rest] = undoStack;
    setUndoStack(rest);
    saveMilestone({ ...prev, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
  };

  // Add note to a specific milestone; optimistically updates the open modal.
  const addNote = useCallback((milestone: Milestone, text: string) => {
    const now      = new Date();
    const dateStr  = now.toISOString().slice(0, 10);
    const newEntry = { text, user: user?.name || "Unknown", date: dateStr };
    const updated  = {
      ...milestone,
      note_entries: [...(milestone.note_entries || []), newEntry],
      updated_at: now.toISOString(),
      updated_by: user?.name || "",
    };
    saveMilestone(updated, true);
    // Optimistic update so the new note appears immediately without closing the modal.
    setNotesModal(prev => prev ? {
      ...prev,
      ms: prev.ms.map(m => m.id === milestone.id ? updated : m),
    } : prev);
  }, [user, saveMilestone]);

  // ── Buyer PO ────────────────────────────────────────────────────────────
  const persistBuyerPo = async (poNumber: string, value: string) => {
    const trimmed = value.trim();
    useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_po: trimmed || null }),
      });
    } catch (e) { console.error("Failed to update buyer_po:", e); }
  };

  // ── Excel export ────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const HDR: any = {
      font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
      fill:      { fgColor: { rgb: "217346" }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: { top: { style: "thin", color: { rgb: "145A2E" } }, bottom: { style: "medium", color: { rgb: "145A2E" } }, left: { style: "thin", color: { rgb: "145A2E" } }, right: { style: "thin", color: { rgb: "145A2E" } } },
    };
    const HDR2: any = { ...HDR, fill: { fgColor: { rgb: "1A5C38" }, patternType: "solid" }, font: { ...HDR.font, sz: 9 } };
    const cellBase: any = { font: { sz: 10, name: "Calibri" }, alignment: { vertical: "center" }, border: { top: { style: "thin", color: { rgb: "D0D8E4" } }, bottom: { style: "thin", color: { rgb: "D0D8E4" } }, left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } } };
    const cellAlt: any  = { ...cellBase, fill: { fgColor: { rgb: "F0FAF4" }, patternType: "solid" } };
    const mono = (b: any): any => ({ ...b, font: { ...b.font, name: "Courier New" } });

    const fixedHdrs1 = ["PO #", "Vendor", "Buyer", "Buyer PO", "DDP", "Days from DDP"];
    const phaseHdrs1: string[] = [];
    const phaseHdrs2: string[] = [];
    phases.forEach(p => { phaseHdrs1.push(p, "", "", "", ""); phaseHdrs2.push("Due Date", "Status", "Status Date", "Days", "Notes"); });

    const row1 = [...fixedHdrs1.map(h => ({ v: h, t: "s", s: HDR })), ...phaseHdrs1.map(h => ({ v: h, t: "s", s: h ? HDR : { ...HDR, fill: { fgColor: { rgb: "1A5C38" }, patternType: "solid" } } }))];
    const row2 = [...fixedHdrs1.map(() => ({ v: "", t: "s", s: HDR2 })), ...phaseHdrs2.map(h => ({ v: h, t: "s", s: HDR2 }))];

    const dataRows = rows.map((po, ri) => {
      const base = ri % 2 === 0 ? cellBase : cellAlt;
      const poNum = po.PoNumber ?? "";
      const poMs  = milestones[poNum] || [];
      const phaseMap = new Map<string, Milestone>();
      poMs.forEach(m => phaseMap.set(m.phase, m));
      const ddp    = po.DateExpectedDelivery;
      const days   = ddp ? Math.ceil((new Date(ddp).getTime() - today.getTime()) / 86400000) : null;
      const daysTxt = days === null ? "" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
      const fixed = [
        { v: poNum, t: "s", s: mono(base) }, { v: po.VendorName || "", t: "s", s: base },
        { v: po.BuyerName || "", t: "s", s: base }, { v: po.BuyerPo || "", t: "s", s: mono(base) },
        { v: fmtDate(ddp) || "", t: "s", s: base }, { v: daysTxt, t: "s", s: base },
      ];
      const phaseCells: any[] = [];
      phases.forEach(phase => {
        const m = phaseMap.get(phase);
        if (!m) { for (let i = 0; i < PHASE_COLS; i++) phaseCells.push({ v: "", t: "s", s: base }); return; }
        const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
        const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "" : daysRem === null ? "" : daysRem < 0 ? `${Math.abs(daysRem)} late` : daysRem === 0 ? "Today" : `${daysRem}`;
        const sdVal = (m.status_dates || {})[m.status] || m.status_date || "";
        const noteCount = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);
        const allNoteText = [
          ...(m.note_entries || []).map(ne => `${ne.date} ${ne.user}: ${ne.text}`),
          ...(m.notes ? [m.notes] : []),
        ].join(" | ");
        phaseCells.push(
          { v: m.expected_date ? fmtDate(m.expected_date) || "" : "", t: "s", s: base },
          { v: m.status, t: "s", s: base },
          { v: sdVal ? fmtDate(sdVal) || "" : "", t: "s", s: base },
          { v: dTxt, t: "s", s: base },
          { v: noteCount > 0 ? allNoteText : "", t: "s", s: base },
        );
      });
      return [...fixed, ...phaseCells];
    });

    const ws = XLSXStyle.utils.aoa_to_sheet([[]]);
    XLSXStyle.utils.sheet_add_aoa(ws, [row1.map(c => c.v), row2.map(c => c.v), ...dataRows.map(r => r.map((c: any) => c.v))]);
    const applyRow = (ri: number, cells: any[]) => cells.forEach((c, ci) => { const addr = XLSXStyle.utils.encode_cell({ r: ri, c: ci }); if (!ws[addr]) ws[addr] = { v: c.v, t: c.t }; ws[addr].s = c.s; });
    applyRow(0, row1); applyRow(1, row2); dataRows.forEach((r, ri) => applyRow(ri + 2, r));
    const fixedWidths = [12, 22, 18, 14, 12, 14];
    const phaseWidths = phases.flatMap(() => [12, 14, 12, 10, 30]);
    ws["!cols"] = [...fixedWidths, ...phaseWidths].map(w => ({ wch: w }));
    ws["!merges"] = phases.map((_, pi) => ({ s: { r: 0, c: fixedHdrs1.length + pi * PHASE_COLS }, e: { r: 0, c: fixedHdrs1.length + pi * PHASE_COLS + PHASE_COLS - 1 } }));
    ws["!rows"] = [{ hpx: 28 }, { hpx: 18 }];
    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, "WIP Grid");
    XLSXStyle.writeFile(wb, `WIP_Grid_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── Cell styles ─────────────────────────────────────────────────────────
  const cell: React.CSSProperties = {
    padding: "4px 7px",
    borderRight:  B_CELL,
    borderBottom: B_CELL,
    borderTop:    B_INNER,
    overflow: "hidden",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
  };

  const hdr1: React.CSSProperties = {
    ...cell,
    background: "#162032",
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderTop:    B_HDR,
    borderBottom: B_HDR,
    borderRight:  B_HDR,
    whiteSpace: "normal",
    wordBreak: "break-word",
    minHeight: 38,
    alignItems: "center",
  };

  const hdr2: React.CSSProperties = {
    ...cell,
    background: "#111827",
    color: "#4B5563",
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderTop:    B_INNER,
    borderBottom: "2px solid #334155",
    borderRight:  B_HDR,
    justifyContent: "center",
    minHeight: 24,
    padding: "3px 4px",
  };

  const sub: React.CSSProperties = {
    ...cell,
    fontSize: 10,
    padding: "2px 4px",
    borderTop: B_INNER,
  };

  // Left border on first column to close the outer frame.
  const firstCol: React.CSSProperties = { borderLeft: B_CELL };

  const ct    = buildColTpl(phases.length);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div style={{ maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div style={{ ...S.filters, flexWrap: "wrap" }}>
        <input
          style={{ ...S.input, flex: 1, minWidth: 240, marginBottom: 0 }}
          placeholder="🔍 Search PO#, vendor, buyer, buyer PO…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select style={{ ...S.select, width: 200 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
          <option value="All">All Vendors</option>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select style={{ ...S.select, width: 200 }} value={filterBuyer} onChange={e => setFilterBuyer(e.target.value)}>
          <option value="All">All Buyers</option>
          {buyers.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterVendor("All"); setFilterBuyer("All"); }}>Clear</button>

        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          title={undoStack.length > 0 ? `Undo last change (${undoStack.length} available)` : "Nothing to undo"}
          style={{ ...S.btnSecondary, opacity: undoStack.length === 0 ? 0.35 : 1, display: "flex", alignItems: "center", gap: 5 }}
        >
          ↩ Undo
        </button>

        <button
          onClick={exportToExcel}
          title="Download as Excel"
          style={{ background: "#217346", border: "1px solid #145A2E", color: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ fontSize: 15 }}>⬇</span> Excel
        </button>
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>

        {/* ── Status bar + pagination ─────────────────────────────────── */}
        <div style={{ padding: "10px 14px", color: "#9CA3AF", fontSize: 13, borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Showing {pageRows.length} of {rows.length} PO{rows.length !== 1 ? "s" : ""} · {phases.length} phase{phases.length !== 1 ? "s" : ""}</span>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page === 0 ? 0.4 : 1 }}>‹ Prev</button>
              <span style={{ color: "#6B7280", fontSize: 11 }}>Page {page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Next ›</button>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No POs match the filters.</div>
        ) : phases.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No milestones generated yet for the visible POs.</div>
        ) : (
          <div className="gv-scroll" style={{ maxHeight: "calc(100vh - 240px)" }}>
            <div style={{ minWidth: "fit-content" }}>

              {/* ── Sticky two-row header ──────────────────────────────── */}
              <div style={{ position: "sticky", top: 0, zIndex: 3 }}>

                {/* Row 1 */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  <span style={{ ...hdr1, ...firstCol }} />
                  <span style={{ ...hdr1 }} />
                  <span style={{ ...hdr1 }}>PO #</span>
                  <span style={{ ...hdr1 }}>Vendor</span>
                  <span style={{ ...hdr1 }}>Buyer</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>Buyer PO</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>DDP</span>
                  <span style={{ ...hdr1, justifyContent: "flex-end" }}>Days from DDP</span>
                  {phases.map((p, i) => (
                    <span key={p} title={p} style={{
                      ...hdr1,
                      gridColumn: `span ${PHASE_COLS}`,
                      justifyContent: "center",
                      background: "#1A2535",
                      color: "#C4B5FD",
                      // Double-thick divider between phases; no border on last
                      borderRight: i === phases.length - 1 ? "none" : B_PHASE,
                      borderBottom: "2px solid #475569",
                    }}>
                      {p}
                    </span>
                  ))}
                </div>

                {/* Row 2 */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <span key={i} style={{ ...hdr2, ...(i === 0 ? firstCol : {}) }} />
                  ))}
                  {phases.map((p, pi) => {
                    const isLast = pi === phases.length - 1;
                    return (
                      <React.Fragment key={p}>
                        <span style={{ ...hdr2 }}>Due Date</span>
                        <span style={{ ...hdr2 }}>Status</span>
                        <span style={{ ...hdr2 }}>Status Date</span>
                        <span style={{ ...hdr2 }}>Days</span>
                        {/* Notes sub-label — double-thick right border between phases */}
                        <span style={{ ...hdr2, borderRight: isLast ? "none" : B_PHASE }}>📝</span>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* ── Data rows ─────────────────────────────────────────── */}
              {pageRows.map(po => {
                const poNum    = po.PoNumber ?? "";
                const poMs     = milestones[poNum] || [];
                const phaseMap = new Map<string, Milestone>();
                poMs.forEach(m => phaseMap.set(m.phase, m));

                const ddp     = po.DateExpectedDelivery;
                const days    = ddp ? Math.ceil((new Date(ddp).getTime() - today.getTime()) / 86400000) : null;
                const daysClr = days === null ? "#6B7280" : days < 0 ? "#EF4444" : days <= 7 ? "#F59E0B" : "#10B981";
                const daysTxt = days === null ? "—" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
                const isEditing  = buyerPoEditing === poNum;
                const isExpanded = expandedPo?.PoNumber === poNum;
                const hasNotes   = poMs.some(m => (m.note_entries && m.note_entries.length > 0) || m.notes);

                return (
                  <div key={poNum} style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: isExpanded ? "#1E293B44" : undefined }}>

                    {/* Expand */}
                    <span
                      style={{ ...cell, ...firstCol, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setExpandedPo(isExpanded ? null : po)}
                      title={isExpanded ? "Collapse" : "Expand line items & milestones"}
                    >
                      <span style={{ fontSize: 16, color: "#F97316", fontWeight: 700, lineHeight: 1 }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </span>

                    {/* Row-level notes — opens all-PO notes + add form */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setNotesModal({ po, ms: poMs })}
                      title={hasNotes ? "View / add PO notes" : "Add PO notes"}
                    >
                      <span style={{ fontSize: 13, color: hasNotes ? "#60A5FA" : "#374151" }}>📝</span>
                    </span>

                    {/* PO # */}
                    <span
                      onClick={() => { setSelected(po); setDetailMode("grid"); setView("list"); }}
                      style={{ ...cell, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12, cursor: "pointer", textDecoration: "underline", whiteSpace: "normal", wordBreak: "break-all" }}
                      title="Open full PO detail"
                    >
                      {poNum}
                    </span>

                    {/* Vendor */}
                    <span style={{ ...cell, color: "#D1D5DB", fontWeight: 600, whiteSpace: "normal", wordBreak: "break-word" }} title={po.VendorName || ""}>
                      {po.VendorName || "—"}
                    </span>

                    {/* Buyer */}
                    <span style={{ ...cell, color: po.BuyerName ? "#D1D5DB" : "#4B5563", whiteSpace: "normal", wordBreak: "break-word" }} title={po.BuyerName || ""}>
                      {po.BuyerName || "—"}
                    </span>

                    {/* Buyer PO */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: isEditing ? "text" : "pointer", color: po.BuyerPo ? "#60A5FA" : "#4B5563", fontFamily: "monospace", padding: isEditing ? 0 : cell.padding }}
                      onClick={() => { if (!isEditing) { setBuyerPoEditing(poNum); setBuyerPoDraft(po.BuyerPo || ""); } }}
                      title={isEditing ? "" : "Click to edit"}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={buyerPoDraft}
                          onChange={e => setBuyerPoDraft(e.target.value)}
                          onBlur={() => { if (buyerPoDraft !== (po.BuyerPo || "")) persistBuyerPo(poNum, buyerPoDraft); setBuyerPoEditing(null); }}
                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") setBuyerPoEditing(null); }}
                          style={{ width: "100%", height: "100%", background: "#0F172A", border: "1px solid #3B82F6", borderRadius: 0, color: "#F1F5F9", fontSize: 11, padding: "3px 6px", fontFamily: "monospace", boxSizing: "border-box", outline: "none", textAlign: "center" }}
                        />
                      ) : (po.BuyerPo || "—")}
                    </span>

                    {/* DDP */}
                    <span style={{ ...cell, justifyContent: "center", color: "#9CA3AF" }}>
                      {fmtDate(ddp) || "—"}
                    </span>

                    {/* Days from DDP */}
                    <span style={{ ...cell, justifyContent: "flex-end", color: daysClr, fontWeight: 700 }}>
                      {daysTxt}
                    </span>

                    {/* Phase sub-cells */}
                    {phases.map((phase, pi) => {
                      const m      = phaseMap.get(phase);
                      const isLast = pi === phases.length - 1;
                      // Notes cell gets double-thick right border between phases
                      const notesBorder: React.CSSProperties = { borderRight: isLast ? "none" : B_PHASE };

                      if (!m) {
                        return (
                          <React.Fragment key={phase}>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...notesBorder }}>—</span>
                          </React.Fragment>
                        );
                      }

                      const daysRem = m.expected_date
                        ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000)
                        : null;
                      const dClr = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280"
                        : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                      const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "—"
                        : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)} late`
                        : daysRem === 0 ? "Today" : `${daysRem}`;
                      const sdVal        = (m.status_dates || {})[m.status] || m.status_date || "";
                      const phaseHasNotes = (m.note_entries && m.note_entries.length > 0) || !!m.notes;
                      const noteCount    = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);

                      return (
                        <React.Fragment key={phase}>
                          {/* Due Date */}
                          <span style={{ ...sub, padding: 2 }}>
                            <MilestoneDateInput
                              value={m.expected_date || ""}
                              onCommit={v => updateField(m, { expected_date: v || null })}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: "#9CA3AF", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                            />
                          </span>

                          {/* Status */}
                          <span style={{ ...sub, padding: 2 }}>
                            <select
                              value={m.status}
                              onChange={e => updateStatus(po, m, e.target.value)}
                              style={{ background: "transparent", border: "none", color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 10, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: "pointer" }}
                            >
                              {MILESTONE_STATUSES.map(s => (
                                <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s], background: "#0F172A" }}>{s}</option>
                              ))}
                            </select>
                          </span>

                          {/* Status Date */}
                          <span style={{ ...sub, padding: 2 }}>
                            <MilestoneDateInput
                              value={sdVal}
                              onCommit={v => {
                                const val = v || null;
                                const dates = { ...(m.status_dates || {}) };
                                if (val) dates[m.status] = val; else delete dates[m.status];
                                updateField(m, { status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null });
                              }}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: sdVal ? "#60A5FA" : "#334155", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                            />
                          </span>

                          {/* Days */}
                          <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700 }}>
                            {dTxt}
                          </span>

                          {/* Per-phase notes — double-thick right border separates phases */}
                          <span
                            style={{ ...sub, justifyContent: "center", cursor: "pointer", padding: 2, ...notesBorder }}
                            onClick={() => setNotesModal({ po, ms: poMs, filterPhase: phase })}
                            title={phaseHasNotes ? `${noteCount} note${noteCount !== 1 ? "s" : ""} — click to view/add` : `Add note for ${phase}`}
                          >
                            <span style={{ fontSize: 11, color: phaseHasNotes ? "#60A5FA" : "#374151" }}>
                              {phaseHasNotes ? `📝${noteCount}` : "📝"}
                            </span>
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Notes modal ───────────────────────────────────────────────────── */}
      {notesModal && (
        <NotesModal
          po={notesModal.po}
          ms={notesModal.ms}
          filterPhase={notesModal.filterPhase}
          onClose={() => setNotesModal(null)}
          onAddNote={addNote}
        />
      )}

      {/* ── PO expand slide-out panel ─────────────────────────────────────── */}
      {expandedPo && (
        <GridPOPanel
          po={expandedPo}
          milestones={milestones[expandedPo.PoNumber ?? ""] || []}
          onClose={() => setExpandedPo(null)}
          saveMilestone={saveMilestone}
          persistBuyerPo={persistBuyerPo}
          user={user}
        />
      )}
    </div>
  );
}
