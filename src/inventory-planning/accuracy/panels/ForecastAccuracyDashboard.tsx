// Phase 5 accuracy dashboard — stat cards + a sortable "top misses"
// table. Uses the aggregateAccuracy helper, no extra math in the UI.

import { useMemo, useState } from "react";
import type { IpForecastAccuracy } from "../types/accuracy";
import { aggregateAccuracy } from "../compute/accuracyMetrics";
import { S, PAL, METHOD_LABEL, formatQty, formatPeriodCode } from "../../components/styles";

export interface ForecastAccuracyDashboardProps {
  rows: IpForecastAccuracy[];
  skuCodeById: Map<string, string>;
  categoryNameById: Map<string, string>;
}

type GroupBy = "sku" | "category" | "customer" | "channel" | "method";

export default function ForecastAccuracyDashboard({ rows, skuCodeById, categoryNameById }: ForecastAccuracyDashboardProps) {
  const [lane, setLane] = useState<"all" | "wholesale" | "ecom">("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("sku");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return rows.filter((r) => lane === "all" ? true : r.forecast_type === lane);
  }, [rows, lane]);

  const overall = useMemo(() => aggregateAccuracy(filtered), [filtered]);

  const grouped = useMemo(() => {
    const m = new Map<string, { label: string; rows: IpForecastAccuracy[] }>();
    for (const r of filtered) {
      let key: string, label: string;
      switch (groupBy) {
        case "sku": key = r.sku_id; label = skuCodeById.get(r.sku_id) ?? r.sku_id.slice(0, 8); break;
        case "category": key = r.category_id ?? "(none)"; label = categoryNameById.get(r.category_id ?? "") ?? "—"; break;
        case "customer": key = r.customer_id ?? "(none)"; label = r.customer_id ? r.customer_id.slice(0, 8) : "—"; break;
        case "channel": key = r.channel_id ?? "(none)"; label = r.channel_id ? r.channel_id.slice(0, 8) : "—"; break;
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
  }, [filtered, groupBy, search, skuCodeById, categoryNameById]);

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
        <select style={S.select} value={lane} onChange={(e) => setLane(e.target.value as "all" | "wholesale" | "ecom")}>
          <option value="all">Both lanes</option>
          <option value="wholesale">Wholesale only</option>
          <option value="ecom">Ecom only</option>
        </select>
        <select style={S.select} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="sku">Group by SKU</option>
          <option value="category">Group by category</option>
          <option value="customer">Group by customer</option>
          <option value="channel">Group by channel</option>
          <option value="method">Group by method</option>
        </select>
        <input style={{ ...S.input, width: 220 }} placeholder="Search label"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          Top {grouped.length} by WAPE (final) · sorted descending
        </span>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>{groupBy}</th>
              <th style={{ ...S.th, textAlign: "right" }}>Rows</th>
              <th style={{ ...S.th, textAlign: "right" }}>Σ actual</th>
              <th style={{ ...S.th, textAlign: "right" }}>WAPE sys</th>
              <th style={{ ...S.th, textAlign: "right" }}>WAPE final</th>
              <th style={{ ...S.th, textAlign: "right" }}>MAE sys</th>
              <th style={{ ...S.th, textAlign: "right" }}>MAE final</th>
              <th style={{ ...S.th, textAlign: "right" }}>Bias final</th>
              <th style={{ ...S.th, textAlign: "right" }}>Δ (sys − final)</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <tr key={g.key}>
                <td style={{ ...S.td, fontFamily: groupBy === "sku" ? "monospace" : undefined, color: groupBy === "sku" ? PAL.accent : PAL.text }}>
                  {g.label}
                </td>
                <td style={S.tdNum}>{g.metrics.row_count}</td>
                <td style={S.tdNum}>{formatQty(g.metrics.total_actual)}</td>
                <td style={{ ...S.tdNum, color: PAL.textDim }}>{pct(g.metrics.wape_system)}</td>
                <td style={{ ...S.tdNum, color: g.metrics.wape_final < g.metrics.wape_system ? PAL.green : PAL.yellow, fontWeight: 700 }}>
                  {pct(g.metrics.wape_final)}
                </td>
                <td style={S.tdNum}>{formatQty(g.metrics.mae_system)}</td>
                <td style={S.tdNum}>{formatQty(g.metrics.mae_final)}</td>
                <td style={{ ...S.tdNum, color: g.metrics.bias_final > 0 ? PAL.yellow : g.metrics.bias_final < 0 ? PAL.red : PAL.textMuted }}>
                  {(g.metrics.bias_final >= 0 ? "+" : "")}{formatQty(g.metrics.bias_final)}
                </td>
                <td style={{ ...S.tdNum, color: g.metrics.mae_delta > 0 ? PAL.green : g.metrics.mae_delta < 0 ? PAL.red : PAL.textMuted }}>
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

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
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
