import React, { useState, useMemo } from "react";
import {
  type XoroPO, type Milestone,
  MILESTONE_STATUS_COLORS, MILESTONE_STATUSES,
  fmtDate, fmtCurrency, poTotal,
  itemQty, isLineClosed, lineDeliveryDate, normalizeSize, sizeSort, todayLocalIso,
} from "../../utils/tandaTypes";
import S from "../styles";

interface GridPOPanelProps {
  po: XoroPO;
  milestones: Milestone[];
  onClose: () => void;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => void;
  persistBuyerPo: (poNumber: string, value: string) => void;
  user: { name?: string } | null;
}

/**
 * Slide-out panel opened from GridView when a PO is expanded. Shows PO
 * meta (with inline editable Buyer PO), line items togglable between a
 * summary-by-base-color view and the full size matrix, and a compact
 * milestones list mirroring the milestoneGridTab look.
 *
 * Does NOT replace detailPanel — that stays available from PO# link.
 * This is a lighter weight drill-down that keeps the user in GridView.
 */
export function GridPOPanel({
  po, milestones, onClose, saveMilestone, persistBuyerPo, user,
}: GridPOPanelProps): React.ReactElement {
  const [itemsView, setItemsView] = useState<"summary" | "matrix">("summary");
  const [buyerPoEdit, setBuyerPoEdit] = useState<string | null>(null);

  const items = po.Items ?? po.PoLineArr ?? [];
  const total = poTotal(po);
  const ddp = po.DateExpectedDelivery;
  const poNum = po.PoNumber ?? "";

  // Parse line items once, used by both summary and matrix views.
  const { parsed, sizeOrder, bySummary, byMatrix, bases } = useMemo(() => {
    const parsed = items.map((item: any) => {
      const sku = item.ItemNumber ?? "";
      const parts = sku.split("-");
      const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
      const base = parts[0] || sku;
      const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
      const closed = isLineClosed(item);
      const displayQty = closed ? (item.QtyOrder ?? 0) : itemQty(item);
      const delivery = (lineDeliveryDate(item, ddp) || "").slice(0, 10);
      return { base, color, size: sz, qty: displayQty, price: item.UnitPrice ?? 0, desc: item.Description ?? "", closed, delivery };
    });

    const sizeSet = new Set<string>();
    parsed.forEach(p => { if (p.size) sizeSet.add(p.size); });
    const sizeOrder = [...sizeSet].sort(sizeSort);

    // Summary view: one row per base+color+delivery group (no size split).
    const summaryMap: Record<string, { base: string; color: string; desc: string; qty: number; price: number; closed: boolean; delivery: string }> = {};
    parsed.forEach(p => {
      const key = `${p.base}|${p.color}|${p.closed ? "c" : "o"}|${p.delivery}`;
      if (!summaryMap[key]) {
        summaryMap[key] = { base: p.base, color: p.color, desc: p.desc, qty: 0, price: p.price, closed: p.closed, delivery: p.delivery };
      }
      summaryMap[key].qty += p.qty;
    });
    const bySummary = Object.values(summaryMap).sort((a, b) => {
      if (a.base !== b.base) return a.base.localeCompare(b.base);
      if (a.color !== b.color) return a.color.localeCompare(b.color);
      return (a.closed ? 1 : 0) - (b.closed ? 1 : 0);
    });

    // Matrix view: base → rows grouped by color+closed+delivery, sizes on cols.
    const matrixMap: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number; closed: boolean; delivery: string }[]> = {};
    const bases: string[] = [];
    parsed.forEach(p => {
      if (!matrixMap[p.base]) { matrixMap[p.base] = []; bases.push(p.base); }
      let row = matrixMap[p.base].find(r => r.color === p.color && r.closed === p.closed && r.delivery === p.delivery);
      if (!row) {
        row = { color: p.color, desc: p.desc, sizes: {}, price: p.price, closed: p.closed, delivery: p.delivery };
        matrixMap[p.base].push(row);
      }
      row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
    });

    return { parsed, sizeOrder, bySummary, byMatrix: matrixMap, bases };
  }, [items, ddp]);

  // Milestones sort: same order the milestones tab uses (earliest due, then sort_order).
  const sortedMs = useMemo(() => {
    return milestones.slice().sort((a, b) => {
      if (a.expected_date && b.expected_date) {
        const d = a.expected_date.localeCompare(b.expected_date);
        if (d !== 0) return d;
      }
      if (a.expected_date && !b.expected_date) return -1;
      if (!a.expected_date && b.expected_date) return 1;
      return a.sort_order - b.sort_order;
    });
  }, [milestones]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const updateMsStatus = (m: Milestone, newStatus: string) => {
    const dates = { ...(m.status_dates || {}) };
    const iso = todayLocalIso();
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

  const cellBase: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: 12,
    borderRight: "1px solid #334155",
    borderBottom: "1px solid #1E293B",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  return (
    <div style={S.detailOverlay} onClick={onClose}>
      <div
        style={{ ...S.detailPanel, width: 820 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={S.detailHeader}>
          <div>
            <div style={S.detailPONum}>{poNum}</div>
            <div style={S.detailVendor}>{po.VendorName || "—"}</div>
            {po.BuyerName && (
              <div style={{ color: "#9CA3AF", fontSize: 13, marginTop: 2 }}>Buyer: {po.BuyerName}</div>
            )}
          </div>
          <button style={S.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        <div style={S.detailBody}>
          {/* PO meta grid */}
          <div style={{ ...S.infoGrid, gridTemplateColumns: "1fr 1fr 1fr 1fr", marginBottom: 16 }}>
            <div style={S.infoCell}>
              <div style={S.infoCellLabel}>DDP</div>
              <div style={S.infoCellValue}>{fmtDate(ddp) || "—"}</div>
            </div>
            <div style={S.infoCell}>
              <div style={S.infoCellLabel}>Status</div>
              <div style={S.infoCellValue}>{po.StatusName || "—"}</div>
            </div>
            <div style={S.infoCell}>
              <div style={S.infoCellLabel}>Total</div>
              <div style={{ ...S.infoCellValue, color: "#10B981", fontFamily: "monospace" }}>
                {fmtCurrency(total, po.CurrencyCode)}
              </div>
            </div>
            <div style={S.infoCell}>
              <div style={S.infoCellLabel}>Buyer PO</div>
              {buyerPoEdit === null ? (
                <div
                  onClick={() => setBuyerPoEdit(po.BuyerPo || "")}
                  style={{ ...S.infoCellValue, fontFamily: "monospace", cursor: "pointer", color: po.BuyerPo ? "#60A5FA" : "#6B7280" }}
                  title="Click to edit"
                >
                  {po.BuyerPo || "— click to set"}
                </div>
              ) : (
                <input
                  autoFocus
                  value={buyerPoEdit}
                  onChange={e => setBuyerPoEdit(e.target.value)}
                  onBlur={() => {
                    if (buyerPoEdit !== null && buyerPoEdit !== (po.BuyerPo || "")) {
                      persistBuyerPo(poNum, buyerPoEdit);
                    }
                    setBuyerPoEdit(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
                    else if (e.key === "Escape") { setBuyerPoEdit(po.BuyerPo || ""); setTimeout(() => setBuyerPoEdit(null)); }
                  }}
                  style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#F1F5F9", fontSize: 14, padding: "6px 8px", fontFamily: "monospace", boxSizing: "border-box", outline: "none" }}
                />
              )}
            </div>
          </div>

          {/* Line Items section with summary/matrix toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ ...S.sectionLabel, margin: 0 }}>Line Items</div>
            <div style={{ display: "inline-flex", border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
              <button
                onClick={() => setItemsView("summary")}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600,
                  background: itemsView === "summary" ? "#3B82F6" : "transparent",
                  color: itemsView === "summary" ? "#fff" : "#94A3B8",
                  border: "none", cursor: "pointer",
                }}
              >Summary</button>
              <button
                onClick={() => setItemsView("matrix")}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600,
                  background: itemsView === "matrix" ? "#3B82F6" : "transparent",
                  color: itemsView === "matrix" ? "#fff" : "#94A3B8",
                  border: "none", cursor: "pointer", borderLeft: "1px solid #334155",
                }}
              >Size Matrix</button>
            </div>
            <span style={{ marginLeft: "auto", color: "#6B7280", fontSize: 11 }}>
              {itemsView === "summary"
                ? `${bySummary.length} row${bySummary.length !== 1 ? "s" : ""}`
                : `${bases.length} base part${bases.length !== 1 ? "s" : ""} · ${sizeOrder.length} sizes`}
            </span>
          </div>

          {itemsView === "summary" ? (
            <div style={{ border: "1px solid #334155", borderRadius: 6, overflow: "hidden", marginBottom: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1.4fr 1fr 70px 90px 110px 90px 110px", background: "#1E293B", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>
                <span style={{ ...cellBase, padding: "8px 10px" }}>Base Part</span>
                <span style={{ ...cellBase, padding: "8px 10px" }}>Description</span>
                <span style={{ ...cellBase, padding: "8px 10px" }}>Color</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "right" }}>Qty</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "right" }}>Unit</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "right" }}>Total</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "center" }}>Status</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "center", borderRight: "none" }}>Delivery</span>
              </div>
              {bySummary.map((r, i) => {
                const rowTotal = r.qty * r.price;
                const dim = r.closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1.4fr 1fr 70px 90px 110px 90px 110px", background: r.closed ? "#1E1B1B" : undefined }}>
                    <span style={{ ...cellBase, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, ...dim }}>{r.base}</span>
                    <span style={{ ...cellBase, color: "#9CA3AF", ...dim }} title={r.desc}>{r.desc || "—"}</span>
                    <span style={{ ...cellBase, color: "#D1D5DB", ...dim }}>{r.color || "—"}</span>
                    <span style={{ ...cellBase, textAlign: "right", color: "#F59E0B", fontFamily: "monospace", fontWeight: 700, ...dim }}>{r.qty}</span>
                    <span style={{ ...cellBase, textAlign: "right", color: "#9CA3AF", fontFamily: "monospace", ...dim }}>{fmtCurrency(r.price, po.CurrencyCode)}</span>
                    <span style={{ ...cellBase, textAlign: "right", color: "#10B981", fontFamily: "monospace", fontWeight: 600, ...dim }}>{fmtCurrency(rowTotal, po.CurrencyCode)}</span>
                    <span style={{ ...cellBase, textAlign: "center", color: r.closed ? "#FCA5A5" : "#10B981", fontSize: 11, fontWeight: 700 }}>
                      {r.closed ? "CLOSED" : "OPEN"}
                    </span>
                    <span style={{ ...cellBase, textAlign: "center", color: "#60A5FA", fontFamily: "monospace", borderRight: "none" }}>
                      {r.delivery ? fmtDate(r.delivery) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ border: "1px solid #334155", borderRadius: 6, overflow: "hidden", marginBottom: 20, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 600 }}>
                <thead>
                  <tr style={{ background: "#1E293B" }}>
                    <th style={{ ...cellBase, padding: "8px 10px", textAlign: "left", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10, fontWeight: 700 }}>Base / Color</th>
                    {sizeOrder.map(sz => (
                      <th key={sz} style={{ ...cellBase, padding: "8px 10px", textAlign: "center", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10, fontWeight: 700, minWidth: 50 }}>{sz}</th>
                    ))}
                    <th style={{ ...cellBase, padding: "8px 10px", textAlign: "center", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10, fontWeight: 700 }}>Total</th>
                    <th style={{ ...cellBase, padding: "8px 10px", textAlign: "right", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10, fontWeight: 700, borderRight: "none" }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {bases.map(base => {
                    const rows = byMatrix[base] || [];
                    return rows.map((row, ri) => {
                      const rowQty = Object.values(row.sizes).reduce((s, q) => s + q, 0);
                      const rowCost = rowQty * row.price;
                      const dim = row.closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
                      return (
                        <tr key={base + "-" + ri + (row.closed ? "c" : "o")} style={{ background: row.closed ? "#1E1B1B" : undefined }}>
                          <td style={{ ...cellBase, color: "#D1D5DB", ...dim }}>
                            <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{base}</span>
                            {row.color && <span style={{ color: "#94A3B8", marginLeft: 8 }}>{row.color}</span>}
                            {row.closed && <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 3, background: "#7F1D1D", color: "#FCA5A5", fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>CLOSED</span>}
                          </td>
                          {sizeOrder.map(sz => (
                            <td key={sz} style={{ ...cellBase, textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace", ...dim }}>{row.sizes[sz] || "—"}</td>
                          ))}
                          <td style={{ ...cellBase, textAlign: "center", color: "#F59E0B", fontFamily: "monospace", fontWeight: 700, ...dim }}>{rowQty}</td>
                          <td style={{ ...cellBase, textAlign: "right", color: "#10B981", fontFamily: "monospace", fontWeight: 600, borderRight: "none", ...dim }}>{fmtCurrency(rowCost, po.CurrencyCode)}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Milestones section — compact mirror of milestoneGridTab */}
          <div style={{ ...S.sectionLabel, marginTop: 4 }}>Milestones</div>
          {sortedMs.length === 0 ? (
            <div style={{ padding: 12, color: "#6B7280", fontSize: 12, background: "#0F172A", borderRadius: 6 }}>
              No milestones yet. They'll auto-generate if this PO has a DDP and its vendor has a template.
            </div>
          ) : (
            <div style={{ border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 110px 120px 70px", background: "#1E293B", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>
                <span style={{ ...cellBase, padding: "8px 10px" }}>Phase</span>
                <span style={{ ...cellBase, padding: "8px 10px" }}>Category</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "center" }}>Due</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "center" }}>Status</span>
                <span style={{ ...cellBase, padding: "8px 10px", textAlign: "right", borderRight: "none" }}>Days</span>
              </div>
              {sortedMs.map(m => {
                const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
                const daysColor =
                  m.status === "Complete" ? "#10B981"
                  : m.status === "N/A" ? "#6B7280"
                  : daysRem === null ? "#6B7280"
                  : daysRem < 0 ? "#EF4444"
                  : daysRem <= 7 ? "#F59E0B"
                  : "#10B981";
                return (
                  <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 110px 120px 70px", alignItems: "center" }}>
                    <span style={{ ...cellBase, color: "#D1D5DB", fontWeight: 600 }}>{m.phase}</span>
                    <span style={{ ...cellBase, color: "#9CA3AF" }}>{m.category}</span>
                    <span style={{ ...cellBase, textAlign: "center", color: "#9CA3AF", fontFamily: "monospace" }}>
                      {m.expected_date ? fmtDate(m.expected_date) : "—"}
                    </span>
                    <span style={{ ...cellBase, textAlign: "center" }}>
                      <select
                        value={m.status}
                        onChange={e => updateMsStatus(m, e.target.value)}
                        style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 11, padding: "3px 4px", width: "100%", fontWeight: 600 }}
                      >
                        {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                      </select>
                    </span>
                    <span style={{ ...cellBase, textAlign: "right", color: daysColor, fontWeight: 700, borderRight: "none" }}>
                      {m.status === "Complete" ? "Done" : m.status === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)}d late` : daysRem === 0 ? "Today" : `${daysRem}d`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
