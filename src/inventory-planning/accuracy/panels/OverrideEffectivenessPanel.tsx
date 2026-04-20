// Override effectiveness panel: grouped by reason, with helped / hurt /
// neutral counts and the average signed error delta. Positive delta
// means "overrides of this reason moved us closer to actual."

import { useMemo, useState } from "react";
import type { IpOverrideEffectiveness } from "../types/accuracy";
import { aggregateOverrideEffectiveness } from "../compute/accuracyMetrics";
import { S, PAL, formatQty } from "../../components/styles";

export interface OverrideEffectivenessPanelProps {
  rows: IpOverrideEffectiveness[];
  skuCodeById: Map<string, string>;
}

export default function OverrideEffectivenessPanel({ rows, skuCodeById }: OverrideEffectivenessPanelProps) {
  const [lane, setLane] = useState<"all" | "wholesale" | "ecom">("all");
  const filtered = useMemo(() => {
    return rows.filter((r) => lane === "all" ? true : r.forecast_type === lane);
  }, [rows, lane]);

  const byReason = useMemo(() => aggregateOverrideEffectiveness(filtered), [filtered]);

  const samples = useMemo(() => {
    // Show 25 of the most-hurt and 25 of the most-helped row-level examples
    const withHelped = filtered.filter((r) => r.override_helped_flag === true).sort((a, b) => (b.error_delta ?? 0) - (a.error_delta ?? 0)).slice(0, 25);
    const withHurt = filtered.filter((r) => r.override_helped_flag === false).sort((a, b) => (a.error_delta ?? 0) - (b.error_delta ?? 0)).slice(0, 25);
    return [...withHelped, ...withHurt];
  }, [filtered]);

  return (
    <div>
      <div style={S.toolbar}>
        <select style={S.select} value={lane} onChange={(e) => setLane(e.target.value as "all" | "wholesale" | "ecom")}>
          <option value="all">Both lanes</option>
          <option value="wholesale">Wholesale</option>
          <option value="ecom">Ecom</option>
        </select>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          {filtered.length} override rows scored.
        </span>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>By override reason</div>
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Reason</th>
                <th style={{ ...S.th, textAlign: "right" }}>Helped</th>
                <th style={{ ...S.th, textAlign: "right" }}>Hurt</th>
                <th style={{ ...S.th, textAlign: "right" }}>Neutral</th>
                <th style={{ ...S.th, textAlign: "right" }}>Avg error Δ</th>
                <th style={S.th}>Net verdict</th>
              </tr>
            </thead>
            <tbody>
              {byReason.map((b) => (
                <tr key={b.key}>
                  <td style={S.td}>{b.label}</td>
                  <td style={{ ...S.tdNum, color: PAL.green }}>{b.helped_count}</td>
                  <td style={{ ...S.tdNum, color: PAL.red }}>{b.hurt_count}</td>
                  <td style={{ ...S.tdNum, color: PAL.textMuted }}>{b.neutral_count}</td>
                  <td style={{ ...S.tdNum, color: b.avg_error_delta > 0 ? PAL.green : b.avg_error_delta < 0 ? PAL.red : PAL.textMuted }}>
                    {(b.avg_error_delta >= 0 ? "+" : "")}{formatQty(b.avg_error_delta)}
                  </td>
                  <td style={S.td}>
                    <span style={{
                      ...S.chip,
                      background: (b.avg_error_delta > 0 ? PAL.green : b.avg_error_delta < 0 ? PAL.red : PAL.textMuted) + "33",
                      color: b.avg_error_delta > 0 ? PAL.green : b.avg_error_delta < 0 ? PAL.red : PAL.textMuted,
                    }}>
                      {b.avg_error_delta > 0 ? "helped overall" : b.avg_error_delta < 0 ? "hurt overall" : "neutral"}
                    </span>
                  </td>
                </tr>
              ))}
              {byReason.length === 0 && (
                <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 32 }}>
                  No override effectiveness data yet.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {samples.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Sample helped / hurt rows</div>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Lane</th>
                  <th style={S.th}>SKU</th>
                  <th style={S.th}>Period</th>
                  <th style={{ ...S.th, textAlign: "right" }}>System</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Final</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Actual</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Δ (sys − final)</th>
                  <th style={S.th}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s) => (
                  <tr key={s.id}>
                    <td style={S.td}>{s.forecast_type}</td>
                    <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                      {skuCodeById.get(s.sku_id) ?? s.sku_id.slice(0, 8)}
                    </td>
                    <td style={S.td}>{s.period_code}</td>
                    <td style={S.tdNum}>{formatQty(s.system_forecast_qty)}</td>
                    <td style={S.tdNum}>{formatQty(s.final_forecast_qty)}</td>
                    <td style={S.tdNum}>{formatQty(s.actual_qty)}</td>
                    <td style={{ ...S.tdNum, color: (s.error_delta ?? 0) > 0 ? PAL.green : PAL.red, fontWeight: 700 }}>
                      {((s.error_delta ?? 0) >= 0 ? "+" : "")}{formatQty(s.error_delta ?? 0)}
                    </td>
                    <td style={S.td}>
                      {s.override_helped_flag === true ? (
                        <span style={{ ...S.chip, background: PAL.green + "33", color: PAL.green }}>helped</span>
                      ) : s.override_helped_flag === false ? (
                        <span style={{ ...S.chip, background: PAL.red + "33", color: PAL.red }}>hurt</span>
                      ) : (
                        <span style={{ ...S.chip, background: PAL.textMuted + "33", color: PAL.textMuted }}>neutral</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
