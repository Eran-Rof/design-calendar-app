// Phase 5 accuracy dashboard — stat cards + a sortable "top misses"
// table. Uses the aggregateAccuracy helper, no extra math in the UI.

import { useMemo, useState } from "react";
import type { IpForecastAccuracy } from "../types/accuracy";
import { aggregateAccuracy } from "../compute/accuracyMetrics";
import { S, PAL, METHOD_LABEL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";

const TABLE_KEY = "ip.forecast_accuracy";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "rows", label: "Rows" },
  { key: "sum_actual", label: "Σ actual" },
  { key: "wape_sys", label: "WAPE sys" },
  { key: "wape_final", label: "WAPE final" },
  { key: "mae_sys", label: "MAE sys" },
  { key: "mae_final", label: "MAE final" },
  { key: "bias_final", label: "Bias final" },
  { key: "delta", label: "Δ (sys − final)" },
];

export interface ForecastAccuracyDashboardProps {
  rows: IpForecastAccuracy[];
  skuCodeById: Map<string, string>;
  categoryNameById: Map<string, string>;
  customerNameById: Map<string, string>;
  channelNameById: Map<string, string>;
}

type GroupBy = "sku" | "category" | "customer" | "channel" | "method";

export default function ForecastAccuracyDashboard({ rows, skuCodeById, categoryNameById, customerNameById, channelNameById }: ForecastAccuracyDashboardProps) {
  const [lane, setLane] = useState<"all" | "wholesale" | "ecom">("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("sku");
  const [search, setSearch] = useState("");
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  const filtered = useMemo(() => {
    return rows.filter((r) => lane === "all" ? true : r.forecast_type === lane);
  }, [rows, lane]);

  const overall = useMemo(() => aggregateAccuracy(filtered), [filtered]);

  const grouped = useMemo(() => {
    const m = new Map<string, { label: string; rows: IpForecastAccuracy[] }>();
    for (const r of filtered) {
      let key: string, label: string;
      switch (groupBy) {
        case "sku": key = r.sku_id; label = skuCodeById.get(r.sku_id) ?? "(unknown sku)"; break;
        case "category": key = r.category_id ?? "(none)"; label = categoryNameById.get(r.category_id ?? "") ?? "—"; break;
        case "customer": key = r.customer_id ?? "(none)"; label = (r.customer_id ? customerNameById.get(r.customer_id) ?? "—" : "—"); break;
        case "channel": key = r.channel_id ?? "(none)"; label = (r.channel_id ? channelNameById.get(r.channel_id) ?? "—" : "—"); break;
        case "method": key = r.forecast_method ?? "(none)"; label = r.forecast_method ? (METHOD_LABEL[r.forecast_method] ?? r.forecast_method) : "—"; break;
      }
      const bucket = m.get(key) ?? { label, rows: [] };
      bucket.rows.push(r);
      m.set(key, bucket);
    }
    const q = search.trim().toUpperCase();
    const out = Array.from(m, ([key, v]) => ({ key, label: v.label, metrics: aggregateAccuracy(v.rows) }));
    return out
      .filter((x) => !q || x.label.toUpperCase().includes(q))
      .sort((a, b) => b.metrics.wape_final - a.metrics.wape_final)
      .slice(0, 200);
  }, [filtered, groupBy, search, skuCodeById, categoryNameById, customerNameById, channelNameById]);

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Rows scored" value={overall.row_count.toLocaleString()} />
        <StatCell label="Σ actual units" value={formatQty(overall.total_actual)} />
        <StatCell label="WAPE system" value={pct(overall.wape_system)} accent={PAL.textDim} />
        <StatCell label="WAPE final" value={pct(overall.wape_final)} accent={overall.wape_final < overall.wape_system ? PAL.green : PAL.yellow} />
        <StatCell label="Overrides Δ" value={(overall.mae_delta >= 0 ? "+" : "") + formatQty(overall.mae_delta)}
                  accent={overall.mae_delta > 0 ? PAL.green : overall.mae_delta < 0 ? PAL.red : PAL.textMuted} />
      </div>

      <div style={S.toolbar}>
        <SearchableSelect
          inputStyle={S.select}
          value={lane}
          onChange={(v) => setLane(v as "all" | "wholesale" | "ecom")}
          options={[
            { value: "all", label: "Both lanes" },
            { value: "wholesale", label: "Wholesale only" },
            { value: "ecom", label: "Ecom only" },
          ]}
        />
        <SearchableSelect
          inputStyle={S.select}
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          options={[
            { value: "sku", label: "Group by SKU" },
            { value: "category", label: "Group by category" },
            { value: "customer", label: "Group by customer" },
            { value: "channel", label: "Group by channel" },
            { value: "method", label: "Group by method" },
          ]}
        />
        <input style={{ ...S.input, width: 220 }} placeholder="Search label"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          Top {grouped.length} by WAPE (final) · sorted descending
        </span>
        <div style={{ marginLeft: "auto" }}>
          <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                            onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
        </div>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>{{ sku: "SKU", category: "Category", customer: "Customer", channel: "Channel", method: "Method" }[groupBy]}</th>
              <th hidden={!visibleColumns.has("rows")} style={{ ...S.th, textAlign: "right" }}>Rows</th>
              <th hidden={!visibleColumns.has("sum_actual")} style={{ ...S.th, textAlign: "right" }}>Σ actual</th>
              <th hidden={!visibleColumns.has("wape_sys")} style={{ ...S.th, textAlign: "right" }}>WAPE sys</th>
              <th hidden={!visibleColumns.has("wape_final")} style={{ ...S.th, textAlign: "right" }}>WAPE final</th>
              <th hidden={!visibleColumns.has("mae_sys")} style={{ ...S.th, textAlign: "right" }}>MAE sys</th>
              <th hidden={!visibleColumns.has("mae_final")} style={{ ...S.th, textAlign: "right" }}>MAE final</th>
              <th hidden={!visibleColumns.has("bias_final")} style={{ ...S.th, textAlign: "right" }}>Bias final</th>
              <th hidden={!visibleColumns.has("delta")} style={{ ...S.th, textAlign: "right" }}>Δ (sys − final)</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <tr key={g.key}>
                <td style={{ ...S.td, fontFamily: groupBy === "sku" ? "monospace" : undefined, color: groupBy === "sku" ? PAL.accent : PAL.text }}>
                  {g.label}
                </td>
                <td hidden={!visibleColumns.has("rows")} style={S.tdNum}>{g.metrics.row_count}</td>
                <td hidden={!visibleColumns.has("sum_actual")} style={S.tdNum}>{formatQty(g.metrics.total_actual)}</td>
                <td hidden={!visibleColumns.has("wape_sys")} style={{ ...S.tdNum, color: PAL.textDim }}>{pct(g.metrics.wape_system)}</td>
                <td hidden={!visibleColumns.has("wape_final")} style={{ ...S.tdNum, color: g.metrics.wape_final < g.metrics.wape_system ? PAL.green : PAL.yellow, fontWeight: 700 }}>
                  {pct(g.metrics.wape_final)}
                </td>
                <td hidden={!visibleColumns.has("mae_sys")} style={S.tdNum}>{formatQty(g.metrics.mae_system)}</td>
                <td hidden={!visibleColumns.has("mae_final")} style={S.tdNum}>{formatQty(g.metrics.mae_final)}</td>
                <td hidden={!visibleColumns.has("bias_final")} style={{ ...S.tdNum, color: g.metrics.bias_final > 0 ? PAL.yellow : g.metrics.bias_final < 0 ? PAL.red : PAL.textMuted }}>
                  {(g.metrics.bias_final >= 0 ? "+" : "")}{formatQty(g.metrics.bias_final)}
                </td>
                <td hidden={!visibleColumns.has("delta")} style={{ ...S.tdNum, color: g.metrics.mae_delta > 0 ? PAL.green : g.metrics.mae_delta < 0 ? PAL.red : PAL.textMuted }}>
                  {(g.metrics.mae_delta >= 0 ? "+" : "")}{formatQty(g.metrics.mae_delta)}
                </td>
              </tr>
            ))}
            {grouped.length === 0 && (
              <tr><td colSpan={9} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                No accuracy rows scored yet. Run the accuracy pass to populate.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ color: PAL.textMuted, fontSize: 11, marginTop: 8 }}>
        Δ (sys − final) &gt; 0 means planner overrides reduced error (overrides helped). Δ &lt; 0 means they worsened it.
      </div>
    </div>
  );
}


function pct(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return `${(n * 100).toFixed(1)}%`;
}

export function formatAccuracyPeriod(code: string): string {
  return formatPeriodCode(code);
}
