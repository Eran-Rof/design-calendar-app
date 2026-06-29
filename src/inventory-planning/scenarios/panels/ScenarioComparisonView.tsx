// Base vs scenario diff view.

import { useMemo, useState } from "react";
import type { ScenarioComparisonRow, ScenarioComparisonTotals } from "../types/scenarios";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const TABLE_KEY = "ip.scenario_comparison";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "sku", label: "SKU" },
  { key: "category", label: "Category" },
  { key: "period", label: "Period" },
  { key: "base_dmd", label: "Base dmd" },
  { key: "scn_dmd", label: "Scn dmd" },
  { key: "delta_dmd", label: "Δ dmd" },
  { key: "base_sup", label: "Base sup" },
  { key: "scn_sup", label: "Scn sup" },
  { key: "delta_sup", label: "Δ sup" },
  { key: "base_end", label: "Base end" },
  { key: "scn_end", label: "Scn end" },
  { key: "delta_short", label: "Δ short" },
  { key: "delta_excess", label: "Δ excess" },
  { key: "base_buy", label: "Base buy" },
  { key: "scn_buy", label: "Scn buy" },
  { key: "delta_buy", label: "Δ buy" },
  { key: "delta_margin", label: "Δ margin $" },
  { key: "base_rec", label: "Base rec" },
  { key: "scn_rec", label: "Scn rec" },
  { key: "risk", label: "Risk" },
];

export interface ScenarioComparisonViewProps {
  rows: ScenarioComparisonRow[];
  totals: ScenarioComparisonTotals;
  loading?: boolean;
}

export default function ScenarioComparisonView({ rows, totals, loading }: ScenarioComparisonViewProps) {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

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
      if (onlyChanged
          && r.demand_delta === 0
          && r.supply_delta === 0
          && r.shortage_delta === 0
          && r.excess_delta === 0
          && r.buy_delta === 0
          && r.margin_dollars_delta === 0
          && r.base_top_rec === r.scenario_top_rec
          && r.base_service_risk === r.scenario_service_risk) return false;
      return true;
    });
  }, [rows, search, filterCategory, onlyChanged]);

  // Additive per-column sort over the filtered comparison rows. Keys map to the
  // scalar each cell renders (delta/base/scenario fields, looked-up names).
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(filtered, {
    persistKey: "ip:scenario_comparison:sort",
    accessors: {
      sku: (r) => r.sku_code,
      category: (r) => r.category_name ?? "",
      period: (r) => r.period_code,
      base_dmd: (r) => r.base_demand,
      scn_dmd: (r) => r.scenario_demand,
      delta_dmd: (r) => r.demand_delta,
      base_sup: (r) => r.base_supply,
      scn_sup: (r) => r.scenario_supply,
      delta_sup: (r) => r.supply_delta,
      base_end: (r) => r.base_ending,
      scn_end: (r) => r.scenario_ending,
      delta_short: (r) => r.shortage_delta,
      delta_excess: (r) => r.excess_delta,
      base_buy: (r) => r.base_planned_buy_qty,
      scn_buy: (r) => r.scenario_planned_buy_qty,
      delta_buy: (r) => r.buy_delta,
      delta_margin: (r) => r.margin_dollars_delta,
      base_rec: (r) => r.base_top_rec ?? "",
      scn_rec: (r) => r.scenario_top_rec ?? "",
      risk: (r) => (r.scenario_service_risk ? 1 : 0),
    },
  });

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Δ demand" value={signed(totals.demand_delta_sum)} accent={totals.demand_delta_sum > 0 ? PAL.accent : totals.demand_delta_sum < 0 ? PAL.yellow : PAL.textMuted} />
        <StatCell label="Δ supply" value={signed(totals.supply_delta_sum)} accent={totals.supply_delta_sum > 0 ? PAL.green : totals.supply_delta_sum < 0 ? PAL.red : PAL.textMuted} />
        <StatCell label="Δ buy" value={signed(totals.buy_delta_sum)} accent={totals.buy_delta_sum > 0 ? PAL.accent : totals.buy_delta_sum < 0 ? PAL.green : PAL.textMuted} />
        <StatCell
          label="Δ margin $"
          value={signedDollars(totals.margin_dollars_delta_sum)}
          accent={totals.margin_dollars_delta_sum > 0 ? PAL.green : totals.margin_dollars_delta_sum < 0 ? PAL.red : PAL.textMuted}
        />
        <StatCell label="Δ shortage" value={signed(totals.shortage_delta_sum)} accent={totals.shortage_delta_sum > 0 ? PAL.red : totals.shortage_delta_sum < 0 ? PAL.green : PAL.textMuted} />
        <StatCell label="Δ excess" value={signed(totals.excess_delta_sum)} accent={totals.excess_delta_sum > 0 ? PAL.yellow : totals.excess_delta_sum < 0 ? PAL.green : PAL.textMuted} />
        <StatCell label="Service risk ±"
                  value={`+${totals.service_risk_added} / −${totals.service_risk_removed}`}
                  accent={totals.service_risk_added > totals.service_risk_removed ? PAL.red : PAL.text} />
        <StatCell label="Stockouts ± / Recs Δ"
                  value={`+${totals.stockouts_added} / −${totals.stockouts_removed} · ${totals.recs_changed}`}
                  accent={PAL.text} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search SKU"
               value={search} onChange={(e) => setSearch(e.target.value)}
               onFocus={(e) => e.currentTarget.select()} />
        <SearchableSelect
          inputStyle={S.select}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v)}
          options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: PAL.textDim, fontSize: 13 }}>
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          Changed only
        </label>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          {filtered.length.toLocaleString()} rows · sorted by impact
        </span>
        <div style={{ marginLeft: "auto" }}>
          <TablePrefsButton
            tableKey={TABLE_KEY}
            columns={ALL_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
            onSetAll={setAllVisible}
          />
        </div>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="SKU" sortKey="sku" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("sku")} />
              <SortableTh label="Category" sortKey="category" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("category")} />
              <SortableTh label="Period" sortKey="period" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("period")} />
              <SortableTh label="Base dmd" sortKey="base_dmd" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("base_dmd")} />
              <SortableTh label="Scn dmd" sortKey="scn_dmd" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("scn_dmd")} />
              <SortableTh label="Δ dmd" sortKey="delta_dmd" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("delta_dmd")} />
              <SortableTh label="Base sup" sortKey="base_sup" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("base_sup")} />
              <SortableTh label="Scn sup" sortKey="scn_sup" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("scn_sup")} />
              <SortableTh label="Δ sup" sortKey="delta_sup" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("delta_sup")} />
              <SortableTh label="Base end" sortKey="base_end" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("base_end")} />
              <SortableTh label="Scn end" sortKey="scn_end" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("scn_end")} />
              <SortableTh label="Δ short" sortKey="delta_short" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("delta_short")} />
              <SortableTh label="Δ excess" sortKey="delta_excess" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("delta_excess")} />
              <SortableTh label="Base buy" sortKey="base_buy" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} title="Planner-typed planned_buy_qty (base)" hidden={!visibleColumns.has("base_buy")} />
              <SortableTh label="Scn buy" sortKey="scn_buy" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} title="Planner-typed planned_buy_qty (scenario)" hidden={!visibleColumns.has("scn_buy")} />
              <SortableTh label="Δ buy" sortKey="delta_buy" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} title="Scenario buy − Base buy" hidden={!visibleColumns.has("delta_buy")} />
              <SortableTh label="Δ margin $" sortKey="delta_margin" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} title="Estimated gross margin $ impact = Δ demand × (unit_cost × margin% / (1 − margin%)). Null when no usable margin data for this (sku, period)." hidden={!visibleColumns.has("delta_margin")} />
              <SortableTh label="Base rec" sortKey="base_rec" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("base_rec")} />
              <SortableTh label="Scn rec" sortKey="scn_rec" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("scn_rec")} />
              <SortableTh label="Risk" sortKey="risk" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} title="Service risk flag from the top recommendation" hidden={!visibleColumns.has("risk")} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.sku_id}:${r.period_start}`}>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }} hidden={!visibleColumns.has("sku")}>{r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim }} hidden={!visibleColumns.has("category")}>{r.category_name ?? "–"}</td>
                <td style={S.td} hidden={!visibleColumns.has("period")}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("base_dmd")}>{formatQty(r.base_demand)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("scn_dmd")}>{formatQty(r.scenario_demand)}</td>
                <td style={{ ...S.tdNum, color: deltaColor(r.demand_delta), fontWeight: 700 }} hidden={!visibleColumns.has("delta_dmd")}>{signed(r.demand_delta)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("base_sup")}>{formatQty(r.base_supply)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("scn_sup")}>{formatQty(r.scenario_supply)}</td>
                <td style={{ ...S.tdNum, color: deltaColor(r.supply_delta), fontWeight: 700 }} hidden={!visibleColumns.has("delta_sup")}>{signed(r.supply_delta)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("base_end")}>{formatQty(r.base_ending)}</td>
                <td style={S.tdNum} hidden={!visibleColumns.has("scn_end")}>{formatQty(r.scenario_ending)}</td>
                <td style={{ ...S.tdNum, color: r.shortage_delta > 0 ? PAL.red : r.shortage_delta < 0 ? PAL.green : PAL.textMuted, fontWeight: 700 }} hidden={!visibleColumns.has("delta_short")}>
                  {signed(r.shortage_delta)}
                </td>
                <td style={{ ...S.tdNum, color: r.excess_delta > 0 ? PAL.yellow : r.excess_delta < 0 ? PAL.green : PAL.textMuted, fontWeight: 700 }} hidden={!visibleColumns.has("delta_excess")}>
                  {signed(r.excess_delta)}
                </td>
                <td style={{ ...S.tdNum, color: r.base_planned_buy_qty > 0 ? PAL.text : PAL.textMuted }} hidden={!visibleColumns.has("base_buy")}>
                  {formatQty(r.base_planned_buy_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.scenario_planned_buy_qty > 0 ? PAL.text : PAL.textMuted }} hidden={!visibleColumns.has("scn_buy")}>
                  {formatQty(r.scenario_planned_buy_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.buy_delta > 0 ? PAL.accent : r.buy_delta < 0 ? PAL.green : PAL.textMuted, fontWeight: 700 }} hidden={!visibleColumns.has("delta_buy")}>
                  {signed(r.buy_delta)}
                </td>
                <td
                  style={{
                    ...S.tdNum,
                    color: r.margin_per_unit_estimate == null
                      ? PAL.textMuted
                      : r.margin_dollars_delta > 0
                        ? PAL.green
                        : r.margin_dollars_delta < 0
                          ? PAL.red
                          : PAL.textMuted,
                    fontWeight: 700,
                  }}
                  hidden={!visibleColumns.has("delta_margin")}
                  title={r.margin_per_unit_estimate == null
                    ? "No margin data for this (sku, period) — estimate skipped"
                    : `~$${r.margin_per_unit_estimate.toFixed(2)} per unit × ${signed(r.demand_delta)} units`}
                >
                  {r.margin_per_unit_estimate == null ? "—" : signedDollars(r.margin_dollars_delta)}
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }} hidden={!visibleColumns.has("base_rec")}>{r.base_top_rec ?? "–"}</td>
                <td style={{ ...S.td, color: r.base_top_rec !== r.scenario_top_rec ? PAL.accent : PAL.textDim, fontSize: 11 }} hidden={!visibleColumns.has("scn_rec")}>
                  {r.scenario_top_rec ?? "–"}
                </td>
                <td style={S.td} hidden={!visibleColumns.has("risk")}>
                  {/* Risk badge — green when newly de-risked, red
                      when newly at risk, yellow when risky in both
                      base + scenario, dim otherwise. */}
                  {r.scenario_service_risk
                    ? (
                      <span style={{ ...S.chip, background: (r.base_service_risk ? PAL.yellow : PAL.red) + "33", color: r.base_service_risk ? PAL.yellow : PAL.red }}>
                        {r.base_service_risk ? "risk" : "+ risk"}
                      </span>
                    )
                    : r.base_service_risk
                      ? <span style={{ ...S.chip, background: PAL.green + "33", color: PAL.green }}>− risk</span>
                      : <span style={{ color: PAL.textMuted, fontSize: 11 }}>–</span>}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={20} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No comparison rows — run the scenario's apply + recompute first."
                  : "No rows match filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={20} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function signed(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const rounded = Math.round(n);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded.toLocaleString()}` : rounded.toLocaleString();
}

function signedDollars(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const rounded = Math.round(n);
  if (rounded === 0) return "$0";
  const sign = rounded > 0 ? "+" : "−";
  return `${sign}$${Math.abs(rounded).toLocaleString()}`;
}

function deltaColor(n: number): string {
  if (n > 0) return PAL.accent;
  if (n < 0) return PAL.yellow;
  return PAL.textMuted;
}
