// Anomaly queue — severity-ranked, filterable. Same shape as the
// Phase 3 exception panel so the muscle memory carries over.

import { useMemo, useState } from "react";
import type { IpPlanningAnomaly } from "../types/intelligence";
import { S, PAL, formatPeriodCode } from "../../components/styles";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F59E0B",
  medium:   "#3B82F6",
  low:      "#94A3B8",
};

const ANOMALY_LABEL: Record<string, string> = {
  demand_spike:                  "Demand spike",
  demand_collapse:               "Demand collapse",
  repeated_forecast_miss:        "Repeated forecast miss",
  chronic_overbuy:               "Chronic overbuy",
  chronic_stockout:              "Chronic stockout",
  return_rate_spike:             "Return-rate spike",
  protected_repeatedly_uncovered: "Protected repeatedly uncovered",
  buyer_request_conversion_miss: "Buyer request conversion miss",
  forecast_volatility:           "Forecast volatility",
};

export interface AnomalyQueueProps {
  anomalies: IpPlanningAnomaly[];
  skuCodeById: Map<string, string>;
}

export default function AnomalyQueue({ anomalies, skuCodeById }: AnomalyQueueProps) {
  const [filterType, setFilterType] = useState("all");
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [criticalOnly, setCriticalOnly] = useState(false);

  const types = useMemo(() => {
    const s = new Set<string>();
    for (const a of anomalies) s.add(a.anomaly_type);
    return Array.from(s).sort();
  }, [anomalies]);

  const filtered = useMemo(() => {
    const out = anomalies.filter((a) => {
      if (criticalOnly && a.severity !== "critical") return false;
      if (filterType !== "all" && a.anomaly_type !== filterType) return false;
      if (filterSeverity !== "all" && a.severity !== filterSeverity) return false;
      return true;
    });
    const sevRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  }, [anomalies, filterType, filterSeverity, criticalOnly]);

  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of anomalies) by.set(a.severity, (by.get(a.severity) ?? 0) + 1);
    return by;
  }, [anomalies]);

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={S.cardTitle}>Anomalies</h3>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          {(["critical", "high", "medium", "low"] as const).map((s) => (
            <button key={s} onClick={() => setFilterSeverity(filterSeverity === s ? "all" : s)}
                    style={{
                      ...S.chip,
                      background: (SEVERITY_COLOR[s] ?? PAL.textMuted) + (filterSeverity === s ? "55" : "22"),
                      color: SEVERITY_COLOR[s] ?? PAL.textMuted,
                      border: filterSeverity === s ? `1px solid ${SEVERITY_COLOR[s]}` : "1px solid transparent",
                      padding: "4px 10px",
                      cursor: "pointer",
                    }}>
              {s}: {counts.get(s) ?? 0}
            </button>
          ))}
        </div>
      </div>
      <div style={S.toolbar}>
        <select style={S.select} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{ANOMALY_LABEL[t] ?? t}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: PAL.textDim, fontSize: 13 }}>
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} />
          Critical only
        </label>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Severity</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>SKU</th>
              <th style={S.th}>Period</th>
              <th style={{ ...S.th, textAlign: "right" }}>Conf.</th>
              <th style={S.th}>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td style={S.td}>
                  <span style={{
                    ...S.chip,
                    background: (SEVERITY_COLOR[a.severity] ?? PAL.textMuted) + "33",
                    color: SEVERITY_COLOR[a.severity] ?? PAL.textMuted,
                  }}>{a.severity}</span>
                </td>
                <td style={S.td}>{ANOMALY_LABEL[a.anomaly_type] ?? a.anomaly_type}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                  {skuCodeById.get(a.sku_id) ?? a.sku_id.slice(0, 8)}
                </td>
                <td style={S.td}>{formatPeriodCode(a.period_code)}</td>
                <td style={{ ...S.tdNum, color: PAL.textDim }}>
                  {a.confidence_score != null ? `${Math.round(a.confidence_score * 100)}%` : "–"}
                </td>
                <td style={{ ...S.td, color: PAL.textDim }}>{a.message}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 32 }}>
                {anomalies.length === 0 ? "No anomalies detected." : "No anomalies match your filters."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
