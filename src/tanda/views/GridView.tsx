import React, { useMemo, useState, useEffect, useRef } from "react";
import { type XoroPO, type Milestone, type View, MILESTONE_STATUS_COLORS, MILESTONE_STATUSES, fmtDate } from "../../utils/tandaTypes";
import S from "../styles";
import { GridPOPanel } from "./GridPOPanel";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { useTandaStore } from "../store/index";

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

/**
 * Cross-PO milestone grid. Rows = POs (filtered by search/vendor/buyer),
 * columns = phase buckets aggregated from all milestones across the
 * filtered POs. Each cell is a status dropdown that writes back through
 * saveMilestone — designed for fast bulk status entry across many POs.
 *
 * Auto-generates milestones for any visible PO that has a DDP + vendor
 * template but no milestones yet — so searching brings in ready-to-edit
 * rows without the user needing to open each PO's detail panel first.
 *
 * Expanding a PO (▸ button) opens GridPOPanel — a lightweight slide-out
 * with line items (summary or matrix), editable Buyer PO, and the PO's
 * milestones. Clicking the PO# link still opens the full detailPanel.
 */
export function GridView({
  pos, milestones, buyers, vendors, setView, setSelected, setDetailMode, saveMilestone,
  ensureMilestones, vendorHasTemplate, user,
}: GridViewProps) {
  const [search, setSearch] = useState("");
  const [filterVendor, setFilterVendor] = useState("All");
  const [filterBuyer, setFilterBuyer] = useState("All");
  const [expandedPo, setExpandedPo] = useState<XoroPO | null>(null);
  const [buyerPoEditing, setBuyerPoEditing] = useState<string | null>(null);
  const [buyerPoDraft, setBuyerPoDraft] = useState("");
  const ensureAttemptedRef = useRef<Set<string>>(new Set());

  const rows = useMemo(() => {
    const s = search.toLowerCase();
    return pos.filter(p => {
      if (filterVendor !== "All" && (p.VendorName ?? "") !== filterVendor) return false;
      if (filterBuyer !== "All" && (p.BuyerName ?? "") !== filterBuyer) return false;
      if (!s) return true;
      return (
        (p.PoNumber ?? "").toLowerCase().includes(s) ||
        (p.VendorName ?? "").toLowerCase().includes(s) ||
        (p.BuyerName ?? "").toLowerCase().includes(s) ||
        (p.BuyerPo ?? "").toLowerCase().includes(s)
      );
    });
  }, [pos, search, filterVendor, filterBuyer]);

  // Auto-generate milestones for visible POs that lack them — but only when a
  // search/filter is active. "When searched POs come up, add phases if they
  // don't exist." Running this on the default unfiltered view would mass-
  // generate milestones for every PO the moment the user clicks into Grid.
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
      // Fire-and-forget. ensureMilestones writes through to state on completion.
      void ensureMilestones(po);
    }
  }, [rows, milestones, ensureMilestones, vendorHasTemplate, hasActiveFilter]);

  // Distinct phase columns across the visible POs. Sorted by their typical
  // sort_order (phases earlier in the WIP template come first).
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

  const updateStatus = (po: XoroPO, m: Milestone, newStatus: string) => {
    const dates = { ...(m.status_dates || {}) };
    const today2 = new Date().toISOString().split("T")[0];
    if (newStatus !== "Not Started" && !dates[newStatus]) dates[newStatus] = today2;
    const statusDate = dates[newStatus] || null;
    saveMilestone({
      ...m,
      status: newStatus,
      status_date: statusDate,
      status_dates: Object.keys(dates).length > 0 ? dates : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    }, true);
  };

  // Persist buyer_po locally + to Supabase. Optimistic; rolls back on network
  // failure is a nice-to-have — for now we just log (internal-only tool).
  const persistBuyerPo = async (poNumber: string, value: string) => {
    const trimmed = value.trim();
    useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ buyer_po: trimmed || null }),
      });
    } catch (e) {
      console.error("Failed to update buyer_po:", e);
    }
  };

  // Excel-style cell defaults — borders on all sides of every cell, no gap.
  const cellBase: React.CSSProperties = {
    padding: "6px 8px",
    borderRight: "1px solid #334155",
    borderBottom: "1px solid #1E293B",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    minHeight: 34,
    boxSizing: "border-box",
  };
  const headerCellBase: React.CSSProperties = {
    ...cellBase,
    background: "#1E293B",
    color: "#6B7280",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 700,
    borderBottom: "2px solid #334155",
    minHeight: 36,
  };

  // Column widths. Order: expand, PO#, vendor, buyer, buyer_po, DDP, days, then phases.
  const colTpl = `32px 140px 180px 150px 130px 100px 80px ${phases.map(() => `130px`).join(" ")}`;

  return (
    <div style={{ maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>
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
        <div style={{ padding: "10px 14px", color: "#9CA3AF", fontSize: 13, borderBottom: "1px solid #1E293B" }}>
          Showing {rows.length} of {pos.length} POs · {phases.length} phase column{phases.length !== 1 ? "s" : ""}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No POs match the filters.</div>
        ) : phases.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No milestones generated yet for the visible POs.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            {/* Header row */}
            <div style={{ display: "grid", gridTemplateColumns: colTpl, position: "sticky", top: 0, minWidth: "fit-content", zIndex: 1 }}>
              <span style={{ ...headerCellBase }} title="Expand"></span>
              <span style={{ ...headerCellBase }}>PO #</span>
              <span style={{ ...headerCellBase }}>Vendor</span>
              <span style={{ ...headerCellBase }}>Buyer</span>
              <span style={{ ...headerCellBase, justifyContent: "center" }}>Buyer PO</span>
              <span style={{ ...headerCellBase, justifyContent: "center" }}>DDP</span>
              <span style={{ ...headerCellBase, justifyContent: "flex-end" }}>Days</span>
              {phases.map((p, i) => (
                <span key={p} style={{ ...headerCellBase, justifyContent: "center", borderRight: i === phases.length - 1 ? "none" : headerCellBase.borderRight }} title={p}>{p}</span>
              ))}
            </div>
            {rows.map(po => {
              const poNum = po.PoNumber ?? "";
              const poMs = milestones[poNum] || [];
              const phaseMap = new Map<string, Milestone>();
              poMs.forEach(m => phaseMap.set(m.phase, m));
              const ddp = po.DateExpectedDelivery;
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const days = ddp ? Math.ceil((new Date(ddp).getTime() - today.getTime()) / 86400000) : null;
              const daysColor = days === null ? "#6B7280" : days < 0 ? "#EF4444" : days <= 7 ? "#F59E0B" : "#10B981";
              const isEditing = buyerPoEditing === poNum;
              return (
                <div key={poNum} style={{ display: "grid", gridTemplateColumns: colTpl, minWidth: "fit-content", background: expandedPo?.PoNumber === poNum ? "#1E293B66" : undefined }}>
                  {/* Expand button */}
                  <span
                    style={{ ...cellBase, justifyContent: "center", cursor: "pointer", color: expandedPo?.PoNumber === poNum ? "#60A5FA" : "#6B7280" }}
                    onClick={() => setExpandedPo(expandedPo?.PoNumber === poNum ? null : po)}
                    title={expandedPo?.PoNumber === poNum ? "Collapse" : "Expand line items & milestones"}
                  >
                    {expandedPo?.PoNumber === poNum ? "▾" : "▸"}
                  </span>

                  {/* PO# — opens full detail panel */}
                  <span
                    onClick={() => { setSelected(po); setDetailMode("grid"); setView("list"); }}
                    style={{ ...cellBase, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 13, cursor: "pointer", textDecoration: "underline" }}
                    title="Open full PO detail"
                  >
                    {poNum}
                  </span>

                  {/* Vendor */}
                  <span style={{ ...cellBase, color: "#D1D5DB", fontWeight: 600 }} title={po.VendorName || ""}>
                    {po.VendorName || "—"}
                  </span>

                  {/* Buyer (dedicated column) */}
                  <span style={{ ...cellBase, color: po.BuyerName ? "#D1D5DB" : "#4B5563" }} title={po.BuyerName || ""}>
                    {po.BuyerName || "—"}
                  </span>

                  {/* Buyer PO (click-to-edit) */}
                  <span
                    style={{ ...cellBase, justifyContent: "center", cursor: isEditing ? "text" : "pointer", color: po.BuyerPo ? "#60A5FA" : "#4B5563", fontFamily: "monospace", padding: isEditing ? 0 : cellBase.padding }}
                    onClick={() => {
                      if (!isEditing) {
                        setBuyerPoEditing(poNum);
                        setBuyerPoDraft(po.BuyerPo || "");
                      }
                    }}
                    title={isEditing ? "" : "Click to edit"}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={buyerPoDraft}
                        onChange={e => setBuyerPoDraft(e.target.value)}
                        onBlur={() => {
                          if (buyerPoDraft !== (po.BuyerPo || "")) persistBuyerPo(poNum, buyerPoDraft);
                          setBuyerPoEditing(null);
                        }}
                        onKeyDown={e => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          else if (e.key === "Escape") setBuyerPoEditing(null);
                        }}
                        style={{ width: "100%", height: "100%", background: "#0F172A", border: "1px solid #3B82F6", borderRadius: 0, color: "#F1F5F9", fontSize: 12, padding: "4px 8px", fontFamily: "monospace", boxSizing: "border-box", outline: "none", textAlign: "center" }}
                      />
                    ) : (po.BuyerPo || "—")}
                  </span>

                  {/* DDP */}
                  <span style={{ ...cellBase, justifyContent: "center", color: "#9CA3AF" }}>
                    {fmtDate(ddp) || "—"}
                  </span>

                  {/* Days */}
                  <span style={{ ...cellBase, justifyContent: "flex-end", color: daysColor, fontWeight: 700 }}>
                    {days === null ? "—" : days < 0 ? `${Math.abs(days)}d late` : days === 0 ? "Today" : `${days}d`}
                  </span>

                  {/* Phase cells */}
                  {phases.map((phase, i) => {
                    const m = phaseMap.get(phase);
                    const isLast = i === phases.length - 1;
                    if (!m) {
                      return (
                        <span key={phase} style={{ ...cellBase, justifyContent: "center", color: "#334155", fontSize: 11, borderRight: isLast ? "none" : cellBase.borderRight }}>
                          —
                        </span>
                      );
                    }
                    return (
                      <span key={phase} style={{ ...cellBase, padding: 2, borderRight: isLast ? "none" : cellBase.borderRight }}>
                        <select
                          value={m.status}
                          onChange={e => updateStatus(po, m, e.target.value)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280",
                            fontSize: 11,
                            padding: "4px 6px",
                            width: "100%",
                            height: "100%",
                            boxSizing: "border-box",
                            fontWeight: 600,
                            outline: "none",
                            cursor: "pointer",
                          }}
                        >
                          {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s], background: "#0F172A" }}>{s}</option>)}
                        </select>
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
