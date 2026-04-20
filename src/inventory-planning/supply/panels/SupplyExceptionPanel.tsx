// Phase 3 exception panel. Filterable by type + severity. Keeps copy
// operational — one line per exception with the exact qty / detail
// that triggered it.

import { useMemo, useState } from "react";
import type { IpSupplyException } from "../types/supply";
import { S, PAL, formatPeriodCode } from "../../components/styles";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F59E0B",
  medium:   "#3B82F6",
  low:      "#94A3B8",
};

const EXCEPTION_LABEL: Record<string, string> = {
  projected_stockout:     "Projected stockout",
  negative_ats:           "Negative ATS",
  late_po:                "Late PO",
  excess_inventory:       "Excess inventory",
  supply_demand_mismatch: "Supply-demand mismatch",
  missing_supply_inputs:  "Missing supply inputs",
  protected_not_covered:  "Protected ecom not covered",
  reserved_not_covered:   "Strategic reserve not covered",
};

export interface SupplyExceptionPanelProps {
  exceptions: IpSupplyException[];
  skuCodeById: Map<string, string>;
}

export default function SupplyExceptionPanel({ exceptions, skuCodeById }: SupplyExceptionPanelProps) {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterSeverity, setFilterSeverity] = useState<string>("all");

  const types = useMemo(() => {
    const s = new Set<string>();
    for (const e of exceptions) s.add(e.exception_type);
    return Array.from(s).sort();
  }, [exceptions]);

  const filtered = useMemo(() => {
    const out = exceptions.filter((e) => {
      if (filterType !== "all" && e.exception_type !== filterType) return false;
      if (filterSeverity !== "all" && e.severity !== filterSeverity) return false;
      return true;
    });
    const sevRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  }, [exceptions, filterType, filterSeverity]);

  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const e of exceptions) by.set(e.severity, (by.get(e.severity) ?? 0) + 1);
    return by;
  }, [exceptions]);

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={S.cardTitle}>Exceptions</h3>
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
          {types.map((t) => <option key={t} value={t}>{EXCEPTION_LABEL[t] ?? t}</option>)}
        </select>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Severity</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>SKU</th>
              <th style={S.th}>Period</th>
              <th style={S.th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td style={S.td}>
                  <span style={{
                    ...S.chip,
                    background: (SEVERITY_COLOR[e.severity] ?? PAL.textMuted) + "33",
                    color: SEVERITY_COLOR[e.severity] ?? PAL.textMuted,
                  }}>{e.severity}</span>
                </td>
                <td style={S.td}>{EXCEPTION_LABEL[e.exception_type] ?? e.exception_type}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                  {skuCodeById.get(e.sku_id) ?? e.sku_id.slice(0, 8)}
                </td>
                <td style={S.td}>{formatPeriodCode(e.period_code)}</td>
                <td style={{ ...S.td, color: PAL.textDim, fontFamily: "monospace", fontSize: 11 }}>
                  {describeDetails(e)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 32 }}>
                {exceptions.length === 0
                  ? "No exceptions — run reconciliation first, or the plan is clean."
                  : "No exceptions match your filters."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describeDetails(e: IpSupplyException): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    parts.push(`${k}=${typeof v === "number" ? Math.round(v) : String(v)}`);
  }
  return parts.join(" · ");
}
