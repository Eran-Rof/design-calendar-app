// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useMemo, useState } from "react";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";

export interface WholesalePlanningGridProps {
  rows: IpPlanningGridRow[];
  onSelectRow: (row: IpPlanningGridRow) => void;
  loading?: boolean;
}

type SortKey =
  | "customer" | "sku" | "period" | "final" | "shortage" | "excess" | "action" | "method";

export default function WholesalePlanningGrid({ rows, onSelectRow, loading }: WholesalePlanningGridProps) {
  const [search, setSearch] = useState("");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  const [filterMethod, setFilterMethod] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("customer");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) s.set(r.customer_id, r.customer_name);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const categories = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) if (r.category_id) s.set(r.category_id, r.category_name ?? r.category_id);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      if (filterCategory !== "all" && r.category_id !== filterCategory) return false;
      if (filterAction !== "all" && r.recommended_action !== filterAction) return false;
      if (filterConfidence !== "all" && r.confidence_level !== filterConfidence) return false;
      if (filterMethod !== "all" && r.forecast_method !== filterMethod) return false;
      if (q && !(r.sku_code.includes(q) || r.customer_name.toUpperCase().includes(q))) return false;
      return true;
    });
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, search, filterCustomer, filterCategory, filterAction, filterConfidence, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = { final: 0, shortage: 0, excess: 0, actions: {} as Record<string, number>, methods: {} as Record<string, number> };
    for (const r of filtered) {
      t.final += r.final_forecast_qty;
      t.shortage += r.projected_shortage_qty;
      t.excess += r.projected_excess_qty;
      t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
      t.methods[r.forecast_method] = (t.methods[r.forecast_method] ?? 0) + 1;
    }
    return t;
  }, [filtered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  return (
    <div>
      {/* Stats row */}
      <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(6,1fr)" }}>
        <StatCell label="Rows" value={filtered.length.toLocaleString()} />
        <StatCell label="Σ Final forecast" value={formatQty(totals.final)} accent={PAL.green} />
        <StatCell label="Σ Shortage" value={formatQty(totals.shortage)} accent={PAL.red} />
        <StatCell label="Σ Excess" value={formatQty(totals.excess)} accent={PAL.yellow} />
        <StatCell label="Buy / Expedite"
                  value={`${totals.actions.buy ?? 0} / ${totals.actions.expedite ?? 0}`}
                  accent={PAL.accent} />
        <StatCell label="LY Sales rows"
                  value={(totals.methods.ly_sales ?? 0).toLocaleString()}
                  accent={PAL.accent2} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search customer or SKU"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
          <option value="all">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
          <option value="all">All actions</option>
          {["buy", "expedite", "reduce", "hold", "monitor"].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select style={S.select} value={filterConfidence} onChange={(e) => setFilterConfidence(e.target.value)}>
          <option value="all">All confidence</option>
          {["committed", "probable", "possible", "estimate"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select style={S.select} value={filterMethod} onChange={(e) => setFilterMethod(e.target.value)}>
          <option value="all">All methods</option>
          {Object.keys(METHOD_LABEL).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>
        <button style={S.btnSecondary} onClick={() => {
          setSearch(""); setFilterCustomer("all"); setFilterCategory("all");
          setFilterAction("all"); setFilterConfidence("all"); setFilterMethod("all");
        }}>Clear</button>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Customer" k="customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={S.th}>Category</th>
              <Th label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Period" k="period" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={{ ...S.th, textAlign: "right" }}>Hist T3</th>
              <th style={{ ...S.th, textAlign: "right" }}>System</th>
              <th style={{ ...S.th, textAlign: "right" }}>Buyer</th>
              <th style={{ ...S.th, textAlign: "right" }}>Override</th>
              <Th label="Final" k="final" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={S.th}>Conf.</th>
              <Th label="Method" k="method" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={{ ...S.th, textAlign: "right" }}>On hand</th>
              <th style={{ ...S.th, textAlign: "right" }}>On PO</th>
              <th style={{ ...S.th, textAlign: "right" }}>Receipts</th>
              <th style={{ ...S.th, textAlign: "right" }}>Available</th>
              <Th label="Short" k="shortage" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Excess" k="excess" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Action" k="action" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.forecast_id}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectRow(r)}>
                <td style={S.td}>{r.customer_name}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_code}</td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.historical_trailing_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.system_forecast_qty)}</td>
                <td style={{ ...S.tdNum, color: r.buyer_request_qty > 0 ? PAL.accent : PAL.textMuted }}>
                  {formatQty(r.buyer_request_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.override_qty !== 0 ? PAL.yellow : PAL.textMuted }}>
                  {r.override_qty > 0 ? "+" : ""}{formatQty(r.override_qty)}
                </td>
                <td style={{ ...S.tdNum, color: PAL.green, fontWeight: 700 }}>
                  {formatQty(r.final_forecast_qty)}
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: CONFIDENCE_COLOR[r.confidence_level] + "33", color: CONFIDENCE_COLOR[r.confidence_level] }}>
                    {r.confidence_level}
                  </span>
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: (METHOD_COLOR[r.forecast_method] ?? PAL.textMuted) + "22", color: METHOD_COLOR[r.forecast_method] ?? PAL.textMuted }}>
                    {METHOD_LABEL[r.forecast_method] ?? r.forecast_method}
                  </span>
                </td>
                <td style={S.tdNum}>{formatQty(r.on_hand_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.on_po_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.receipts_due_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.text }}>{formatQty(r.available_supply_qty)}</td>
                <td style={{ ...S.tdNum, color: r.projected_shortage_qty > 0 ? PAL.red : PAL.textMuted }}>
                  {formatQty(r.projected_shortage_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.projected_excess_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {formatQty(r.projected_excess_qty)}
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: (ACTION_COLOR[r.recommended_action] ?? PAL.textMuted) + "33", color: ACTION_COLOR[r.recommended_action] ?? PAL.textMuted }}>
                    {r.recommended_action}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={18} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
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

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

function cmp(a: IpPlanningGridRow, b: IpPlanningGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "customer": return a.customer_name.localeCompare(b.customer_name) * sign;
    case "sku":      return a.sku_code.localeCompare(b.sku_code) * sign;
    case "period":   return a.period_start.localeCompare(b.period_start) * sign;
    case "final":    return (a.final_forecast_qty - b.final_forecast_qty) * sign;
    case "shortage": return (a.projected_shortage_qty - b.projected_shortage_qty) * sign;
    case "excess":   return (a.projected_excess_qty - b.projected_excess_qty) * sign;
    case "action":   return a.recommended_action.localeCompare(b.recommended_action) * sign;
    case "method":   return a.forecast_method.localeCompare(b.forecast_method) * sign;
  }
}
