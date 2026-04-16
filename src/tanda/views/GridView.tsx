import React, { useMemo, useState, useEffect, useRef } from "react";
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

// Fixed column widths: expand | notes | PO# | Vendor | Buyer | BuyerPO | DDP | Days
const FIXED_COLS = "32px 32px 130px 160px 140px 110px 90px 62px";
// Per-phase sub-columns: Due Date | Status | Status Date | Days
const PHASE_SUB = "90px 110px 90px 48px";

function buildColTpl(phaseCount: number) {
  return phaseCount > 0
    ? `${FIXED_COLS} ${Array(phaseCount).fill(PHASE_SUB).join(" ")}`
    : FIXED_COLS;
}

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
  // Inject scrollbar CSS once — styled to match the app dark theme.
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

  const [search, setSearch]               = useState("");
  const [filterVendor, setFilterVendor]   = useState("All");
  const [filterBuyer, setFilterBuyer]     = useState("All");
  const [expandedPo, setExpandedPo]       = useState<XoroPO | null>(null);
  const [buyerPoEditing, setBuyerPoEditing] = useState<string | null>(null);
  const [buyerPoDraft, setBuyerPoDraft]   = useState("");
  const [page, setPage]                   = useState(0);
  const [notesModal, setNotesModal]       = useState<{ po: XoroPO; ms: Milestone[] } | null>(null);
  const ensureAttemptedRef                = useRef<Set<string>>(new Set());

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

  // Reset page whenever filters change.
  useEffect(() => setPage(0), [search, filterVendor, filterBuyer]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Auto-generate milestones for visible POs when a filter is active.
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

  // Derive phases from ALL rows (not just pageRows) so columns stay stable across pages.
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

  // ── Milestone mutation helpers ─────────────────────────────────────────
  const updateStatus = (po: XoroPO, m: Milestone, newStatus: string) => {
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

  const updateField = (m: Milestone, patch: Partial<Milestone>) =>
    saveMilestone({ ...m, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);

  // ── Buyer PO persistence ───────────────────────────────────────────────
  const persistBuyerPo = async (poNumber: string, value: string) => {
    const trimmed = value.trim();
    useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_po: trimmed || null }),
      });
    } catch (e) {
      console.error("Failed to update buyer_po:", e);
    }
  };

  // ── Cell styles ────────────────────────────────────────────────────────
  const cell: React.CSSProperties = {
    padding: "4px 7px",
    borderRight: "1px solid #1E293B",
    borderBottom: "1px solid #1E293B",
    overflow: "hidden",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
  };

  // Row-1 header: wraps text so long phase names don't stretch the column.
  const hdr1: React.CSSProperties = {
    ...cell,
    background: "#162032",
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #334155",
    whiteSpace: "normal",
    wordBreak: "break-word",
    minHeight: 38,
    alignItems: "center",
  };

  // Row-2 header: sub-labels (Due Date / Status / Status Date / Days).
  const hdr2: React.CSSProperties = {
    ...cell,
    background: "#111827",
    color: "#4B5563",
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: "2px solid #334155",
    justifyContent: "center",
    minHeight: 24,
    padding: "3px 4px",
  };

  // Sub-cell inside each phase column (50% the size of milestones tab cells).
  const sub: React.CSSProperties = { ...cell, fontSize: 10, padding: "2px 4px" };

  const ct    = buildColTpl(phases.length);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div style={{ maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>

      {/* ── Filters ───────────────────────────────────────────────────── */}
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
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>

        {/* ── Status bar + pagination ──────────────────────────────── */}
        <div style={{ padding: "10px 14px", color: "#9CA3AF", fontSize: 13, borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>
            Showing {pageRows.length} of {rows.length} PO{rows.length !== 1 ? "s" : ""} · {phases.length} phase{phases.length !== 1 ? "s" : ""}
          </span>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page === 0 ? 0.4 : 1 }}
              >‹ Prev</button>
              <span style={{ color: "#6B7280", fontSize: 11 }}>Page {page + 1} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page >= totalPages - 1 ? 0.4 : 1 }}
              >Next ›</button>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No POs match the filters.</div>
        ) : phases.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No milestones generated yet for the visible POs.</div>
        ) : (
          /* ── Scrollable grid ────────────────────────────────────────── */
          <div className="gv-scroll" style={{ maxHeight: "calc(100vh - 240px)" }}>
            <div style={{ minWidth: "fit-content" }}>

              {/* Sticky two-row header */}
              <div style={{ position: "sticky", top: 0, zIndex: 3 }}>

                {/* Row 1 — fixed labels + phase group label (spans 4 sub-cols each) */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  <span style={{ ...hdr1 }} />
                  <span style={{ ...hdr1 }} />
                  <span style={{ ...hdr1 }}>PO #</span>
                  <span style={{ ...hdr1 }}>Vendor</span>
                  <span style={{ ...hdr1 }}>Buyer</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>Buyer PO</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>DDP</span>
                  <span style={{ ...hdr1, justifyContent: "flex-end" }}>Days from DDP</span>
                  {phases.map((p, i) => (
                    <span
                      key={p}
                      title={p}
                      style={{
                        ...hdr1,
                        gridColumn: "span 4",
                        justifyContent: "center",
                        background: "#1A2535",
                        color: "#C4B5FD",
                        borderRight: i === phases.length - 1 ? "none" : hdr1.borderRight,
                        borderBottom: "1px solid #475569",
                      }}
                    >
                      {p}
                    </span>
                  ))}
                </div>

                {/* Row 2 — sub-column labels for each phase */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <span key={i} style={{ ...hdr2 }} />
                  ))}
                  {phases.map((p, pi) => (
                    <React.Fragment key={p}>
                      <span style={{ ...hdr2 }}>Due Date</span>
                      <span style={{ ...hdr2 }}>Status</span>
                      <span style={{ ...hdr2 }}>Status Date</span>
                      <span style={{ ...hdr2, borderRight: pi === phases.length - 1 ? "none" : hdr2.borderRight }}>Days</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* ── Data rows ──────────────────────────────────────────── */}
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
                  <div
                    key={poNum}
                    style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: isExpanded ? "#1E293B44" : undefined }}
                  >
                    {/* Expand — orange, 20% larger than default icon */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setExpandedPo(isExpanded ? null : po)}
                      title={isExpanded ? "Collapse" : "Expand line items & milestones"}
                    >
                      <span style={{ fontSize: 16, color: "#F97316", fontWeight: 700, lineHeight: 1 }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </span>

                    {/* Notes — blue when notes exist */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setNotesModal({ po, ms: poMs })}
                      title={hasNotes ? "View PO notes" : "No notes yet"}
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

                    {/* Buyer PO — inline editable */}
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

                    {/* Days from DDP — no "d" suffix, "late" for overdue */}
                    <span style={{ ...cell, justifyContent: "flex-end", color: daysClr, fontWeight: 700 }}>
                      {daysTxt}
                    </span>

                    {/* Phase sub-cells: Due Date | Status | Status Date | Days */}
                    {phases.map((phase, pi) => {
                      const m      = phaseMap.get(phase);
                      const isLast = pi === phases.length - 1;
                      const lastBorder: React.CSSProperties = isLast ? { borderRight: "none" } : {};

                      if (!m) {
                        return (
                          <React.Fragment key={phase}>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...lastBorder }}>—</span>
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
                      const sdVal = (m.status_dates || {})[m.status] || m.status_date || "";

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
                            <input
                              type="date"
                              value={sdVal}
                              onChange={e => {
                                const val = e.target.value || null;
                                const dates = { ...(m.status_dates || {}) };
                                if (val) dates[m.status] = val; else delete dates[m.status];
                                updateField(m, { status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null });
                              }}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: sdVal ? "#60A5FA" : "#334155", fontSize: 10, padding: "1px 2px", width: "100%", boxSizing: "border-box", colorScheme: "dark" }}
                            />
                          </span>

                          {/* Days */}
                          <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700, ...lastBorder }}>
                            {dTxt}
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
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setNotesModal(null)}
        >
          <div
            style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: 560, maxHeight: "70vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#0F172A", zIndex: 1 }}>
              <div>
                <div style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>{notesModal.po.PoNumber}</div>
                <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>All Milestone Notes</div>
              </div>
              <button onClick={() => setNotesModal(null)} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {notesModal.ms.filter(m => (m.note_entries && m.note_entries.length > 0) || m.notes).length === 0 ? (
                <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: "24px 0" }}>No notes for this PO yet.</div>
              ) : (
                notesModal.ms
                  .filter(m => (m.note_entries && m.note_entries.length > 0) || m.notes)
                  .map(m => (
                    <div key={m.id} style={{ marginBottom: 18 }}>
                      <div style={{ color: "#C4B5FD", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>
                        {m.phase}
                        <span style={{ marginLeft: 8, color: "#6B7280", fontWeight: 400, textTransform: "none", fontSize: 10 }}>{m.category}</span>
                      </div>
                      {m.note_entries && m.note_entries.length > 0
                        ? m.note_entries.map((ne, i) => (
                            <div key={i} style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px", marginBottom: 6 }}>
                              <div style={{ color: "#E5E7EB", fontSize: 12 }}>{ne.text}</div>
                              <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>{ne.user} · {ne.date}</div>
                            </div>
                          ))
                        : m.notes
                          ? (
                            <div style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px" }}>
                              <div style={{ color: "#E5E7EB", fontSize: 12 }}>{m.notes}</div>
                            </div>
                          )
                          : null}
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
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
