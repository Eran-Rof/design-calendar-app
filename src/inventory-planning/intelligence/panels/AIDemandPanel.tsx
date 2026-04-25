// AI demand prediction panel. Calls Claude via the /api/internal/ip-ai-demand
// route, passing sales history, inventory, and forecast context. Claude
// returns per-SKU predictions with market factor commentary and flags.

import { useState } from "react";
import type { AIDemandPrediction, AIDemandResult } from "../types/aiDemand";
import { runAIDemandPrediction } from "../services/aiDemandService";
import { S, PAL, formatQty } from "../../components/styles";
import type { ToastMessage } from "../../components/Toast";

const FLAG_COLOR: Record<string, string> = {
  review_urgently:   PAL.red,
  potential_stockout: PAL.yellow,
  excess_risk:       PAL.accent2,
  suppressed_demand: PAL.accent,
};
const FLAG_LABEL: Record<string, string> = {
  review_urgently:   "Review urgently",
  potential_stockout: "Stockout risk",
  excess_risk:       "Excess risk",
  suppressed_demand: "Suppressed demand",
};
const DIR_ICON: Record<string, string> = { up: "↑", down: "↓", flat: "→" };
const DIR_COLOR: Record<string, string> = { up: PAL.green, down: PAL.red, flat: PAL.textMuted };

export interface AIDemandPanelProps {
  planningRunId: string | null;
  onToast: (t: ToastMessage) => void;
}

export default function AIDemandPanel({ planningRunId, onToast }: AIDemandPanelProps) {
  const [result, setResult] = useState<AIDemandResult | null>(null);
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [flagFilter, setFlagFilter] = useState<string>("all");
  const [selected, setSelected] = useState<AIDemandPrediction | null>(null);

  async function run() {
    if (!planningRunId) { onToast({ text: "Select a planning run first", kind: "error" }); return; }
    setRunning(true);
    setResult(null);
    setSelected(null);
    try {
      const r = await runAIDemandPrediction(planningRunId);
      setResult(r);
      onToast({ text: `AI analysis complete — ${r.predictions.length} SKUs scored`, kind: "success" });
    } catch (e) {
      onToast({ text: "AI demand prediction failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setRunning(false);
    }
  }

  const predictions = result?.predictions ?? [];
  const filtered = predictions.filter(p => {
    const q = search.trim().toUpperCase();
    const matchSearch = !q || p.sku_code.toUpperCase().includes(q);
    const matchFlag = flagFilter === "all" || (flagFilter === "flagged" ? p.flag !== null : p.flag === flagFilter);
    return matchSearch && matchFlag;
  }).sort((a, b) => {
    if (a.flag && !b.flag) return -1;
    if (!a.flag && b.flag) return 1;
    return b.confidence_score - a.confidence_score;
  });

  const flagCounts = predictions.reduce<Record<string, number>>((acc, p) => {
    if (p.flag) acc[p.flag] = (acc[p.flag] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "flex", gap: 16 }}>
      {/* Main panel */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Controls */}
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: PAL.text }}>AI Demand Prediction</div>
              <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 2 }}>
                Claude analyzes 24 months of sales, inventory, and forecast data alongside market knowledge
              </div>
            </div>
            <button
              style={{ ...S.btnPrimary, minWidth: 160 }}
              onClick={run}
              disabled={running || !planningRunId}
            >
              {running ? "Analyzing…" : "Run AI Prediction"}
            </button>
          </div>
          {result && (
            <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 8, borderTop: `1px solid ${PAL.border}`, paddingTop: 8 }}>
              {result.context_summary.run_name} · {result.context_summary.horizon} ·{" "}
              {result.context_summary.skus_analyzed} SKUs · model {result.context_summary.model} ·{" "}
              generated {new Date(result.generated_at).toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* Flag summary chips */}
        {Object.keys(flagCounts).length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <FlagChip label={`All (${predictions.length})`} color={PAL.accent} active={flagFilter === "all"} onClick={() => setFlagFilter("all")} />
            <FlagChip label={`Flagged (${Object.values(flagCounts).reduce((s, v) => s + v, 0)})`} color={PAL.red} active={flagFilter === "flagged"} onClick={() => setFlagFilter("flagged")} />
            {Object.entries(flagCounts).map(([flag, count]) => (
              <FlagChip key={flag} label={`${FLAG_LABEL[flag]} (${count})`} color={FLAG_COLOR[flag]} active={flagFilter === flag} onClick={() => setFlagFilter(flag)} />
            ))}
          </div>
        )}

        {/* Search */}
        {result && (
          <div style={S.toolbar}>
            <input style={{ ...S.input, width: 220 }} placeholder="Search SKU" value={search} onChange={e => setSearch(e.target.value)} />
            <span style={{ fontSize: 12, color: PAL.textMuted }}>{filtered.length} of {predictions.length} SKUs</span>
          </div>
        )}

        {/* Idle state */}
        {!result && !running && (
          <div style={{ ...S.card, textAlign: "center", padding: 60, color: PAL.textMuted }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🤖</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: PAL.text }}>No prediction run yet</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Select a planning run and click "Run AI Prediction" to analyze demand using Claude.
            </div>
          </div>
        )}

        {running && (
          <div style={{ ...S.card, textAlign: "center", padding: 60, color: PAL.textMuted }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: PAL.text }}>Analyzing demand data…</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Claude is reviewing your sales history, inventory, and market context. This takes ~15–30 seconds.
            </div>
          </div>
        )}

        {/* Results table */}
        {result && filtered.length > 0 && (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>SKU</th>
                  <th style={{ ...S.th, textAlign: "center" }}>Dir</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Predicted</th>
                  <th style={{ ...S.th, textAlign: "right" }}>vs Forecast</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Confidence</th>
                  <th style={S.th}>Flag</th>
                  <th style={S.th}>Top Signal</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr
                    key={p.sku_id}
                    style={{ cursor: "pointer", background: selected?.sku_id === p.sku_id ? PAL.panel : undefined }}
                    onClick={() => setSelected(p.sku_id === selected?.sku_id ? null : p)}
                  >
                    <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent, fontWeight: 600 }}>{p.sku_code}</td>
                    <td style={{ ...S.td, textAlign: "center", color: DIR_COLOR[p.direction], fontWeight: 700, fontSize: 16 }}>
                      {DIR_ICON[p.direction]}
                    </td>
                    <td style={S.tdNum}>{formatQty(p.predicted_qty)}</td>
                    <td style={{ ...S.tdNum, color: p.vs_current_forecast_pct === null ? PAL.textMuted : p.vs_current_forecast_pct > 0 ? PAL.green : PAL.red, fontWeight: 600 }}>
                      {p.vs_current_forecast_pct === null ? "—" : `${p.vs_current_forecast_pct > 0 ? "+" : ""}${p.vs_current_forecast_pct}%`}
                    </td>
                    <td style={{ ...S.tdNum, color: p.confidence_score >= 0.7 ? PAL.green : p.confidence_score >= 0.45 ? PAL.yellow : PAL.red }}>
                      {Math.round(p.confidence_score * 100)}%
                    </td>
                    <td style={S.td}>
                      {p.flag ? (
                        <span style={{ background: FLAG_COLOR[p.flag] + "33", color: FLAG_COLOR[p.flag], borderRadius: 4, padding: "2px 6px", fontSize: 11, fontWeight: 600 }}>
                          {FLAG_LABEL[p.flag]}
                        </span>
                      ) : <span style={{ color: PAL.textMuted, fontSize: 11 }}>—</span>}
                    </td>
                    <td style={{ ...S.td, color: PAL.textMuted, fontSize: 11, maxWidth: 200 }}>
                      {p.key_signals?.[0] ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: PAL.textMuted }}>No SKUs match the current filter.</div>
        )}
      </div>

      {/* Detail drawer */}
      {selected && (
        <div style={{ width: 340, flexShrink: 0 }}>
          <div style={{ ...S.card, position: "sticky", top: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, color: PAL.accent, fontSize: 16 }}>{selected.sku_code}</div>
                {selected.flag && (
                  <span style={{ background: FLAG_COLOR[selected.flag] + "33", color: FLAG_COLOR[selected.flag], borderRadius: 4, padding: "2px 6px", fontSize: 11, fontWeight: 600, marginTop: 4, display: "inline-block" }}>
                    {FLAG_LABEL[selected.flag]}
                  </span>
                )}
              </div>
              <button style={S.btnGhost} onClick={() => setSelected(null)}>✕</button>
            </div>

            <StatRow label="Predicted qty" value={formatQty(selected.predicted_qty)} color={DIR_COLOR[selected.direction]} />
            <StatRow label="Direction" value={`${DIR_ICON[selected.direction]} ${selected.direction}`} color={DIR_COLOR[selected.direction]} />
            <StatRow label="vs Current forecast" value={selected.vs_current_forecast_pct === null ? "—" : `${selected.vs_current_forecast_pct > 0 ? "+" : ""}${selected.vs_current_forecast_pct}%`} />
            <StatRow label="Confidence" value={`${Math.round(selected.confidence_score * 100)}%`} color={selected.confidence_score >= 0.7 ? PAL.green : selected.confidence_score >= 0.45 ? PAL.yellow : PAL.red} />

            <div style={{ marginTop: 16, marginBottom: 4, fontSize: 11, fontWeight: 700, color: PAL.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>Rationale</div>
            <div style={{ fontSize: 12, color: PAL.text, lineHeight: 1.6 }}>{selected.rationale}</div>

            {(selected.key_signals?.length ?? 0) > 0 && (
              <>
                <div style={{ marginTop: 16, marginBottom: 4, fontSize: 11, fontWeight: 700, color: PAL.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>Data Signals</div>
                <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                  {selected.key_signals.map((s, i) => (
                    <li key={i} style={{ fontSize: 12, color: PAL.text, marginBottom: 4 }}>{s}</li>
                  ))}
                </ul>
              </>
            )}

            {selected.market_factors.length > 0 && (
              <>
                <div style={{ marginTop: 16, marginBottom: 4, fontSize: 11, fontWeight: 700, color: PAL.accent2, textTransform: "uppercase", letterSpacing: 1 }}>Market Factors</div>
                <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                  {selected.market_factors.map((f, i) => (
                    <li key={i} style={{ fontSize: 12, color: PAL.text, marginBottom: 4 }}>{f}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FlagChip({ label, color, active, onClick }: { label: string; color: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ background: active ? color + "33" : "transparent", border: `1px solid ${active ? color : PAL.border}`, color: active ? color : PAL.textMuted, borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
      {label}
    </button>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${PAL.border}` }}>
      <span style={{ fontSize: 11, color: PAL.textMuted }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color ?? PAL.text }}>{value}</span>
    </div>
  );
}
