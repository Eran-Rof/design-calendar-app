// Anomaly queue — severity-ranked, filterable. Same shape as the
// Phase 3 exception panel so the muscle memory carries over.

import { useMemo, useState } from "react";
import type { IpPlanningAnomaly } from "../types/intelligence";
import { S, PAL, formatPeriodCode } from "../../components/styles";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const TABLE_KEY = "ip.anomaly_queue";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "severity", label: "Severity" },
  { key: "type", label: "Type" },
  { key: "sku", label: "SKU" },
  { key: "period", label: "Period" },
  { key: "conf", label: "Conf." },
  { key: "message", label: "Message" },
];

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
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

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

  // Additive per-column sort over the filtered anomalies. When unsorted, rows
  // keep the severity-ranked natural order above. Type/SKU/period map to the
  // looked-up / formatted values the cells render; the rest are direct scalars.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(filtered, {
    persistKey: "ip:anomaly_queue:sort",
    accessors: {
      type: (a) => ANOMALY_LABEL[a.anomaly_type] ?? a.anomaly_type,
      sku: (a) => skuCodeById.get(a.sku_id) ?? "",
      period: (a) => a.period_code ?? "",
      conf: (a) => a.confidence_score ?? null,
    },
  });

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
        <SearchableSelect
          value={filterType}
          onChange={(v) => setFilterType(v)}
          options={[
            { value: "all", label: "All types" },
            ...types.map((t) => ({ value: t, label: ANOMALY_LABEL[t] ?? t })),
          ]}
          inputStyle={S.select}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: PAL.textDim, fontSize: 13 }}>
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} />
          Critical only
        </label>
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
              <SortableTh label="Severity" sortKey="severity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("severity")} />
              <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("type")} />
              <SortableTh label="SKU" sortKey="sku" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("sku")} />
              <SortableTh label="Period" sortKey="period" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("period")} />
              <SortableTh label="Conf." sortKey="conf" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("conf")} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Message" sortKey="message" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("message")} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                <td style={S.td} hidden={!visibleColumns.has("severity")}>
                  <span style={{
                    ...S.chip,
                    background: (SEVERITY_COLOR[a.severity] ?? PAL.textMuted) + "33",
                    color: SEVERITY_COLOR[a.severity] ?? PAL.textMuted,
                  }}>{a.severity}</span>
                </td>
                <td style={S.td} hidden={!visibleColumns.has("type")}>{ANOMALY_LABEL[a.anomaly_type] ?? a.anomaly_type}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }} hidden={!visibleColumns.has("sku")}>
                  {skuCodeById.get(a.sku_id) ?? "(unknown sku)"}
                </td>
                <td style={S.td} hidden={!visibleColumns.has("period")}>{formatPeriodCode(a.period_code)}</td>
                <td style={{ ...S.tdNum, color: PAL.textDim }} hidden={!visibleColumns.has("conf")}>
                  {a.confidence_score != null ? `${Math.round(a.confidence_score * 100)}%` : "–"}
                </td>
                <td style={{ ...S.td, color: PAL.textDim }} hidden={!visibleColumns.has("message")}>{a.message}</td>
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
