// Base vs scenario diff view.

import { useMemo, useState } from "react";
import type { ScenarioComparisonRow, ScenarioComparisonTotals } from "../types/scenarios";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";

export interface ScenarioComparisonViewProps {
  rows: ScenarioComparisonRow[];
  totals: ScenarioComparisonTotals;
  loading?: boolean;
}

export default function ScenarioComparisonView({ rows, totals, loading }: ScenarioComparisonViewProps) {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [onlyChanged, setOnlyChanged] = useState(true);

  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.category_id) m.set(r.category_id, r.category_name ?? r.category_id);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (filterCategory !== "all" && r.category_id !== filterCategory) return false;
      if (q && !r.sku_code.includes(q)) return false;
      if (onlyChanged && r.demand_delta === 0 && r.supply_delta === 0 && r.shortage_delta === 0 && r.excess_delta === 0 && r.base_top_rec === r.scenario_top_rec) return false;
      return true;
    });
  }, [rows, search, filterCategory, onlyChanged]);

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Δ demand" value={signed(totals.demand_delta_sum)} accent={totals.demand_delta_sum > 0 ? PAL.accent : totals.demand_delta_sum < 0 ? PAL.yellow : PAL.textMuted} />
        <StatCell label="Δ supply" value={signed(totals.supply_delta_sum)} accent={totals.supply_delta_sum > 0 ? PAL.green : totals.supply_delta_sum < 0 ? PAL.red : PAL.textMuted} />
        <StatCell label="Δ shortage" value={signed(totals.shortage_delta_sum)} accent={totals.shortage_delta_sum > 0 ? PAL.red : totals.shortage_delta_sum < 0 ? PAL.green : PAL.textMuted} />
        <StatCell label="Δ excess" value={signed(totals.excess_delta_sum)} accent={totals.excess_delta_sum > 0 ? PAL.yellow : totals.excess_delta_sum < 0 ? PAL.green : PAL.textMuted} />
        <StatCell label="Stockouts ± / Recs Δ"
                  value={`${totals.stockouts_added} / −${totals.stockouts_removed} · ${totals.recs_changed}`}
                  accent={PAL.text} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search SKU"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: PAL.textDim, fontSize: 13 }}>
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          Changed only
        </label>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          {filtered.length.toLocaleString()} rows · sorted by impact
        </span>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>SKU</th>
              <th style={S.th}>Category</th>
              <th style={S.th}>Period</th>
              <th style={{ ...S.th, textAlign: "right" }}>Base dmd</th>
              <th style={{ ...S.th, textAlign: "right" }}>Scn dmd</th>
              <th style={{ ...S.th, textAlign: "right" }}>Δ dmd</th>
              <th style={{ ...S.th, textAlign: "right" }}>Base sup</th>
              <th style={{ ...S.th, textAlign: "right" }}>Scn sup</th>
              <th style={{ ...S.th, textAlign: "right" }}>Δ sup</th>
              <th style={{ ...S.th, textAlign: "right" }}>Base end</th>
              <th style={{ ...S.th, textAlign: "right" }}>Scn end</th>
              <th style={{ ...S.th, textAlign: "right" }}>Δ short</th>
              <th style={{ ...S.th, textAlign: "right" }}>Δ excess</th>
              <th style={S.th}>Base rec</th>
              <th style={S.th}>Scn rec</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={`${r.sku_id}:${r.period_start}`}>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.base_demand)}</td>
                <td style={S.tdNum}>{formatQty(r.scenario_demand)}</td>
                <td style={{ ...S.tdNum, color: deltaColor(r.demand_delta), fontWeight: 700 }}>{signed(r.demand_delta)}</td>
                <td style={S.tdNum}>{formatQty(r.base_supply)}</td>
                <td style={S.tdNum}>{formatQty(r.scenario_supply)}</td>
                <td style={{ ...S.tdNum, color: deltaColor(r.supply_delta), fontWeight: 700 }}>{signed(r.supply_delta)}</td>
                <td style={S.tdNum}>{formatQty(r.base_ending)}</td>
                <td style={S.tdNum}>{formatQty(r.scenario_ending)}</td>
                <td style={{ ...S.tdNum, color: r.shortage_delta > 0 ? PAL.red : r.shortage_delta < 0 ? PAL.green : PAL.textMuted, fontWeight: 700 }}>
                  {signed(r.shortage_delta)}
                </td>
                <td style={{ ...S.tdNum, color: r.excess_delta > 0 ? PAL.yellow : r.excess_delta < 0 ? PAL.green : PAL.textMuted, fontWeight: 700 }}>
                  {signed(r.excess_delta)}
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }}>{r.base_top_rec ?? "–"}</td>
                <td style={{ ...S.td, color: r.base_top_rec !== r.scenario_top_rec ? PAL.accent : PAL.textDim, fontSize: 11 }}>
                  {r.scenario_top_rec ?? "–"}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={15} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No comparison rows — run the scenario's apply + recompute first."
                  : "No rows match filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={15} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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

function signed(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const rounded = Math.round(n);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded.toLocaleString()}` : rounded.toLocaleString();
}

function deltaColor(n: number): string {
  if (n > 0) return PAL.accent;
  if (n < 0) return PAL.yellow;
  return PAL.textMuted;
}
