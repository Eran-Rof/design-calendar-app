// Detail drawer for a selected (sku, period). Shows the full
// reconciliation: supply components, demand breakdown (customer +
// channel), allocation waterfall trace, and every recommendation the
// engine emitted for that grain.

import { useEffect, useMemo, useState } from "react";
import type {
  AllocationBreakdown,
  DemandInputsForSku,
  IpAllocationRule,
  IpInventoryRecommendation,
  IpReconciliationGridRow,
  SupplyInputsForSku,
} from "../types/supply";
import { computeAllocation } from "../compute/allocationEngine";
import { activeRulesForSku } from "../compute/supplyReconciliation";
import { S, PAL, formatDate, formatQty, formatPeriodCode } from "../../components/styles";
import { MiniCell } from "../../components/MiniCell";

export interface AllocationDetailDrawerProps {
  row: IpReconciliationGridRow | null;
  rules: IpAllocationRule[];
  recommendations: IpInventoryRecommendation[];
  // Optional: if the parent knows the demand breakdown already it can
  // pass it in; otherwise we approximate from the row totals.
  demand?: DemandInputsForSku;
  onClose: () => void;
}

export default function AllocationDetailDrawer({
  row, rules, recommendations, demand, onClose,
}: AllocationDetailDrawerProps) {
  const [trace, setTrace] = useState<AllocationBreakdown["trace"]>([]);

  const applicableRules = useMemo(() => {
    if (!row) return [];
    return activeRulesForSku(rules, row.sku_id, row.category_id);
  }, [rules, row?.sku_id, row?.category_id]);

  useEffect(() => {
    if (!row) { setTrace([]); return; }
    const supply: SupplyInputsForSku = {
      sku_id: row.sku_id,
      beginning_on_hand_qty: row.beginning_on_hand_qty,
      ats_qty: row.ats_qty,
      inbound_receipts_qty: row.inbound_receipts_qty,
      inbound_po_qty: row.inbound_po_qty,
      wip_qty: row.wip_qty,
    };
    const dem: DemandInputsForSku = demand ?? {
      sku_id: row.sku_id,
      wholesale_demand_qty: row.wholesale_demand_qty,
      ecom_demand_qty: row.ecom_demand_qty,
      protected_ecom_qty: row.protected_ecom_qty,
      wholesale_by_customer: [],
      ecom_by_channel: [],
    };
    const totalSupply = supply.beginning_on_hand_qty + supply.inbound_receipts_qty + supply.inbound_po_qty + supply.wip_qty;
    const alloc = computeAllocation(totalSupply, dem, applicableRules);
    setTrace(alloc.trace);
  }, [row?.projected_id, applicableRules, demand]);

  if (!row) return null;

  const recsForRow = recommendations.filter(
    (r) => r.sku_id === row.sku_id && r.period_start === row.period_start,
  );

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={{ ...S.drawer, width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <div>
            <div style={{ fontSize: 13, color: PAL.textMuted }}>{row.category_name ?? "—"}</div>
            <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: PAL.accent }}>
              {row.sku_code}
            </div>
            <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 2 }}>
              {row.sku_description ?? ""} · {formatPeriodCode(row.period_code)} · {formatDate(row.period_start)}–{formatDate(row.period_end)}
            </div>
          </div>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>

        <div style={S.drawerBody}>
          {/* ── supply ── */}
          <SectionLabel>Supply</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            <MiniCell label="On hand" value={formatQty(row.beginning_on_hand_qty)} />
            <MiniCell label="ATS" value={formatQty(row.ats_qty)} />
            <MiniCell label="Inbound PO" value={formatQty(row.inbound_po_qty)} />
            <MiniCell label="Receipts" value={formatQty(row.inbound_receipts_qty)} />
            <MiniCell label="WIP" value={formatQty(row.wip_qty)} />
            <MiniCell label="Total supply" value={formatQty(row.total_available_supply_qty)} accent={PAL.accent} />
          </div>
          <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 4 }}>
            Total supply excludes ATS to avoid double-counting on-hand.
          </div>

          {/* ── demand ── */}
          <SectionLabel>Demand</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            <MiniCell label="Wholesale" value={formatQty(row.wholesale_demand_qty)} />
            <MiniCell label="Ecom" value={formatQty(row.ecom_demand_qty)} />
            <MiniCell label="Total" value={formatQty(row.wholesale_demand_qty + row.ecom_demand_qty)} accent={PAL.text} />
          </div>
          {demand && demand.wholesale_by_customer.length > 0 && (
            <div style={{ ...S.infoCell, marginTop: 8 }}>
              <div style={S.infoLabel}>Wholesale by customer</div>
              {demand.wholesale_by_customer.map((c) => (
                <div key={c.customer_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: PAL.textDim, fontFamily: "monospace" }}>{c.customer_id.slice(0, 8)}</span>
                  <span style={{ fontFamily: "monospace" }}>{formatQty(c.qty)}</span>
                </div>
              ))}
            </div>
          )}
          {demand && demand.ecom_by_channel.length > 0 && (
            <div style={{ ...S.infoCell, marginTop: 8 }}>
              <div style={S.infoLabel}>Ecom by channel</div>
              {demand.ecom_by_channel.map((c) => (
                <div key={c.channel_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: PAL.textDim, fontFamily: "monospace" }}>{c.channel_id.slice(0, 8)}</span>
                  <span style={{ fontFamily: "monospace" }}>
                    {formatQty(c.qty)} · <span style={{ color: PAL.green }}>protected {formatQty(c.protected)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── allocation trace ── */}
          <SectionLabel>Allocation waterfall</SectionLabel>
          <div style={S.infoCell}>
            {trace.map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                <span style={{ color: PAL.textDim }}>{t.step}{t.note ? <span style={{ color: PAL.textMuted }}> · {t.note}</span> : ""}</span>
                <span style={{ fontFamily: "monospace", color: PAL.text }}>{formatQty(t.supply_after)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px dashed ${PAL.border}`, marginTop: 6, paddingTop: 6 }}>
              <span style={{ color: PAL.textDim }}>ending inventory</span>
              <span style={{ fontFamily: "monospace", color: PAL.green, fontWeight: 700 }}>{formatQty(row.ending_inventory_qty)}</span>
            </div>
          </div>

          {/* ── shortage / excess summary ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginTop: 10 }}>
            <MiniCell label="Shortage" value={formatQty(row.shortage_qty)} accent={row.shortage_qty > 0 ? PAL.red : PAL.textMuted} />
            <MiniCell label="Excess" value={formatQty(row.excess_qty)} accent={row.excess_qty > 0 ? PAL.yellow : PAL.textMuted} />
          </div>

          {/* ── rules applied ── */}
          {applicableRules.length > 0 && (
            <>
              <SectionLabel>Rules applied</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {applicableRules.map((r) => (
                  <div key={r.id} style={{ ...S.infoCell, padding: "8px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 600 }}>{r.rule_name}</span>
                      <span style={{ color: PAL.textMuted, fontSize: 12 }}>#{r.priority_rank} · {r.rule_type}</span>
                    </div>
                    <div style={{ fontSize: 12, color: PAL.textDim }}>
                      {r.reserve_qty != null ? `reserve_qty=${r.reserve_qty}` : ""}
                      {r.reserve_percent != null ? ` reserve_percent=${(r.reserve_percent * 100).toFixed(1)}%` : ""}
                      {r.note ? ` — ${r.note}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── recommendations ── */}
          <SectionLabel>Recommendations</SectionLabel>
          {recsForRow.length === 0 ? (
            <div style={{ color: PAL.textMuted, fontSize: 12 }}>No recommendations — nothing to act on.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {recsForRow.map((r) => (
                <div key={r.id} style={{ ...S.infoCell, padding: "8px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600 }}>
                      {r.recommendation_type}{r.recommendation_qty != null ? ` · ${formatQty(r.recommendation_qty)} units` : ""}
                    </span>
                    <span style={{ ...S.chip, background: priorityColor(r.priority_level) + "33", color: priorityColor(r.priority_level) }}>
                      {r.priority_level}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 2 }}>{r.action_reason ?? ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 8px" }}>
      {children}
    </div>
  );
}


function priorityColor(p: string): string {
  switch (p) {
    case "critical": return "#EF4444";
    case "high":     return "#F59E0B";
    case "medium":   return "#3B82F6";
    default:         return "#94A3B8";
  }
}
