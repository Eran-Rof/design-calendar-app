// Phase 3 reconciliation grid. One row per (sku, month).
// Columns per spec — kept wide so planners can scan end-to-end.

import { useMemo, useState } from "react";
import type { IpReconciliationGridRow } from "../types/supply";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";

export interface ReconciliationGridProps {
  rows: IpReconciliationGridRow[];
  loading?: boolean;
  onSelectRow: (row: IpReconciliationGridRow) => void;
}

type SortKey = "sku" | "period" | "supply" | "demand" | "shortage" | "excess" | "priority";

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F59E0B",
  medium:   "#3B82F6",
  low:      "#94A3B8",
};

const ACTION_COLOR: Record<string, string> = {
  buy:               "#3B82F6",
  expedite:          "#EF4444",
  reduce:            "#F59E0B",
  hold:              "#6B7280",
  monitor:           "#94A3B8",
  reallocate:        "#8B5CF6",
  cancel_receipt:    "#F59E0B",
  push_receipt:      "#3B82F6",
  protect_inventory: "#10B981",
};

const PAGE_SIZE = 500;

export default function ReconciliationGrid({ rows, loading, onSelectRow }: ReconciliationGridProps) {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterStockout, setFilterStockout] = useState<"all" | "stockout" | "ok">("all");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.category_id) m.set(r.category_id, r.category_name ?? r.category_id);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Two-step memo: first the full filtered+sorted set, then the page-cap
  // slice. The pre-cap count drives the "showing first N of M" indicator —
  // collapsing them lost that signal because filtered.length was already
  // capped at PAGE_SIZE.
  const filteredAll = useMemo(() => {
    const q = search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (filterCategory !== "all" && r.category_id !== filterCategory) return false;
      if (filterPriority !== "all" && r.top_recommendation_priority !== filterPriority) return false;
      if (filterAction !== "all" && r.top_recommendation !== filterAction) return false;
      if (filterStockout === "stockout" && !r.projected_stockout_flag) return false;
      if (filterStockout === "ok" && r.projected_stockout_flag) return false;
      if (q && !(r.sku_code.includes(q) || (r.sku_description ?? "").toUpperCase().includes(q))) return false;
      return true;
    });
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, search, filterCategory, filterPriority, filterAction, filterStockout, sortKey, sortDir]);
  const filtered = useMemo(() => filteredAll.slice(0, PAGE_SIZE), [filteredAll]);

  const totals = useMemo(() => {
    const t = { supply: 0, demand: 0, shortage: 0, excess: 0, stockouts: 0, critical: 0 };
    for (const r of filtered) {
      t.supply += r.total_available_supply_qty;
      t.demand += r.wholesale_demand_qty + r.ecom_demand_qty;
      t.shortage += r.shortage_qty;
      t.excess += r.excess_qty;
      if (r.projected_stockout_flag) t.stockouts++;
      if (r.top_recommendation_priority === "critical") t.critical++;
    }
    return t;
  }, [filtered]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "shortage" || k === "excess" ? "desc" : "asc"); }
  }

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Rows" value={filteredAll.length > PAGE_SIZE ? `${PAGE_SIZE.toLocaleString()} / ${filteredAll.length.toLocaleString()}` : filteredAll.length.toLocaleString()} accent={filteredAll.length > PAGE_SIZE ? PAL.yellow : undefined} />
        <StatCell label="Σ Supply" value={formatQty(totals.supply)} accent={PAL.accent} />
        <StatCell label="Σ Demand" value={formatQty(totals.demand)} accent={PAL.text} />
        <StatCell label="Σ Shortage" value={formatQty(totals.shortage)} accent={PAL.red} />
        <StatCell label="Stockouts / Critical" value={`${totals.stockouts} / ${totals.critical}`} accent={PAL.red} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search SKU or description"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
          <option value="all">All priorities</option>
          <option value="critical">Critical only</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select style={S.select} value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
          <option value="all">All actions</option>
          {Object.keys(ACTION_COLOR).map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
        </select>
        <select style={S.select} value={filterStockout} onChange={(e) => setFilterStockout(e.target.value as "all" | "stockout" | "ok")}>
          <option value="all">Stockout: any</option>
          <option value="stockout">Projected stockouts</option>
          <option value="ok">Covered</option>
        </select>
        <button style={S.btnSecondary} onClick={() => {
          setSearch(""); setFilterCategory("all"); setFilterPriority("all");
          setFilterAction("all"); setFilterStockout("all");
        }}>Clear</button>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={S.th}>Category</th>
              <Th label="Period" k="period" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={{ ...S.th, textAlign: "right" }}>On hand</th>
              <th style={{ ...S.th, textAlign: "right" }}>ATS</th>
              <th style={{ ...S.th, textAlign: "right" }}>Inbound PO</th>
              <th style={{ ...S.th, textAlign: "right" }}>Receipts</th>
              <th style={{ ...S.th, textAlign: "right" }}>WIP</th>
              <Th label="Supply" k="supply" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={{ ...S.th, textAlign: "right" }}>W/s dmd</th>
              <th style={{ ...S.th, textAlign: "right" }}>Ecom dmd</th>
              <th style={{ ...S.th, textAlign: "right" }}>Protected</th>
              <th style={{ ...S.th, textAlign: "right" }}>Reserved</th>
              <th style={{ ...S.th, textAlign: "right" }}>Allocated</th>
              <th style={{ ...S.th, textAlign: "right" }}>Ending</th>
              <Th label="Shortage" k="shortage" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Excess" k="excess" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Action" k="priority" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.projected_id}
                  style={{ cursor: "pointer", background: r.projected_stockout_flag ? "#3f1d1d22" : undefined }}
                  onClick={() => onSelectRow(r)}>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.beginning_on_hand_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.textDim }}>{formatQty(r.ats_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.inbound_po_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.inbound_receipts_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.textMuted }}>{formatQty(r.wip_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.accent, fontWeight: 700 }}>{formatQty(r.total_available_supply_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.wholesale_demand_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.ecom_demand_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.green }}>{formatQty(r.protected_ecom_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.yellow }}>{formatQty(r.reserved_wholesale_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.text, fontWeight: 600 }}>{formatQty(r.allocated_total_qty)}</td>
                <td style={{ ...S.tdNum, color: r.ending_inventory_qty > 0 ? PAL.textDim : PAL.textMuted }}>
                  {formatQty(r.ending_inventory_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.shortage_qty > 0 ? PAL.red : PAL.textMuted }}>
                  {formatQty(r.shortage_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.excess_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {formatQty(r.excess_qty)}
                </td>
                <td style={S.td}>
                  {r.top_recommendation ? (
                    <span style={{
                      ...S.chip,
                      background: (ACTION_COLOR[r.top_recommendation] ?? PAL.textMuted) + "33",
                      color: ACTION_COLOR[r.top_recommendation] ?? PAL.textMuted,
                      marginRight: 6,
                    }}>
                      {r.top_recommendation}
                    </span>
                  ) : "–"}
                  {r.top_recommendation_priority && (
                    <span style={{
                      ...S.chip,
                      background: (PRIORITY_COLOR[r.top_recommendation_priority] ?? PAL.textMuted) + "33",
                      color: PRIORITY_COLOR[r.top_recommendation_priority] ?? PAL.textMuted,
                    }}>
                      {r.top_recommendation_priority}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={18} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No reconciled rows yet. Run the reconciliation pass above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={18} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filteredAll.length > PAGE_SIZE && (
        <div style={{ padding: 8, color: PAL.textMuted, fontSize: 12, textAlign: "right" }}>
          Showing first {PAGE_SIZE.toLocaleString()} of {filteredAll.length.toLocaleString()} — use filters to narrow.
        </div>
      )}
    </div>
  );
}

function Th({ label, k, sortKey, sortDir, onSort, numeric }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean;
}) {
  const active = sortKey === k;
  return (
    <th style={{ ...S.th, cursor: "pointer", textAlign: numeric ? "right" : "left", color: active ? PAL.text : PAL.textMuted }}
        onClick={() => onSort(k)}>
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}


function cmp(a: IpReconciliationGridRow, b: IpReconciliationGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  const pRank = (p: string | null) => (p === "critical" ? 0 : p === "high" ? 1 : p === "medium" ? 2 : p === "low" ? 3 : 4);
  switch (k) {
    case "sku":      return a.sku_code.localeCompare(b.sku_code) * sign;
    case "period":   return a.period_start.localeCompare(b.period_start) * sign;
    case "supply":   return (a.total_available_supply_qty - b.total_available_supply_qty) * sign;
    case "demand":   return ((a.wholesale_demand_qty + a.ecom_demand_qty) - (b.wholesale_demand_qty + b.ecom_demand_qty)) * sign;
    case "shortage": return (a.shortage_qty - b.shortage_qty) * sign;
    case "excess":   return (a.excess_qty - b.excess_qty) * sign;
    case "priority": return (pRank(a.top_recommendation_priority) - pRank(b.top_recommendation_priority)) * sign;
  }
}
