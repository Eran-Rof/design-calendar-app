import React, { useMemo, useState } from "react";
import { type XoroPO, type Milestone, type View, MILESTONE_STATUS_COLORS, MILESTONE_STATUSES, fmtDate } from "../../utils/tandaTypes";
import S from "../styles";

interface GridViewProps {
  pos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  buyers: string[];
  vendors: string[];
  setView: (v: View) => void;
  setSelected: (po: XoroPO | null) => void;
  setDetailMode: (m: any) => void;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => void;
  user: { name?: string } | null;
}

/**
 * Cross-PO milestone grid. Rows = POs (filtered by search/vendor/buyer),
 * columns = phase buckets aggregated from all milestones across the
 * filtered POs. Each cell is a status dropdown that writes back through
 * saveMilestone — designed for fast bulk status entry across many POs.
 */
export function GridView({
  pos, milestones, buyers, vendors, setView, setSelected, setDetailMode, saveMilestone, user,
}: GridViewProps) {
  const [search, setSearch] = useState("");
  const [filterVendor, setFilterVendor] = useState("All");
  const [filterBuyer, setFilterBuyer] = useState("All");

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

  const phaseColMin = 130;
  const colTpl = `180px 1fr 130px 100px 100px ${phases.map(() => `${phaseColMin}px`).join(" ")}`;

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
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: colTpl, gap: 4, padding: "10px 12px", background: "#1E293B", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, position: "sticky", top: 0, minWidth: "fit-content" }}>
              <span>PO #</span>
              <span>Vendor / Buyer</span>
              <span style={{ textAlign: "center" }}>Buyer PO</span>
              <span style={{ textAlign: "center" }}>DDP</span>
              <span style={{ textAlign: "right" }}>Days</span>
              {phases.map(p => <span key={p} style={{ textAlign: "center" }}>{p}</span>)}
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
              return (
                <div key={poNum} style={{ display: "grid", gridTemplateColumns: colTpl, gap: 4, padding: "8px 12px", borderTop: "1px solid #1E293B", alignItems: "center", minWidth: "fit-content" }}>
                  <span
                    onClick={() => { setSelected(po); setDetailMode("grid"); setView("list"); }}
                    style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 13, cursor: "pointer", textDecoration: "underline" }}
                    title="Open PO detail"
                  >
                    {poNum}
                  </span>
                  <span style={{ color: "#D1D5DB", fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>{po.VendorName || "—"}</div>
                    {po.BuyerName && <div style={{ color: "#9CA3AF", fontSize: 11 }}>Buyer: {po.BuyerName}</div>}
                  </span>
                  <span style={{ textAlign: "center", color: po.BuyerPo ? "#60A5FA" : "#4B5563", fontFamily: "monospace", fontSize: 12 }}>
                    {po.BuyerPo || "—"}
                  </span>
                  <span style={{ textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>{fmtDate(ddp) || "—"}</span>
                  <span style={{ textAlign: "right", color: daysColor, fontWeight: 700, fontSize: 12 }}>
                    {days === null ? "—" : days < 0 ? `${Math.abs(days)}d late` : days === 0 ? "Today" : `${days}d`}
                  </span>
                  {phases.map(phase => {
                    const m = phaseMap.get(phase);
                    if (!m) return <span key={phase} style={{ textAlign: "center", color: "#334155", fontSize: 11 }}>—</span>;
                    return (
                      <select
                        key={phase}
                        value={m.status}
                        onChange={e => updateStatus(po, m, e.target.value)}
                        style={{
                          background: "#1E293B",
                          border: "1px solid #334155",
                          borderRadius: 6,
                          color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280",
                          fontSize: 11,
                          padding: "4px 6px",
                          width: "100%",
                          boxSizing: "border-box",
                          fontWeight: 600,
                        }}
                      >
                        {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                      </select>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
