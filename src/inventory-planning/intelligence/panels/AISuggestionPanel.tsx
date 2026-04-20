// Phase 5 AI suggestion list. Each row shows the suggestion type, the
// proposed delta / target qty, a confidence bar, and the rationale.
// Accept / ignore buttons are one-click and the write is audited via
// accepted_flag + accepted_at.

import { useMemo, useState } from "react";
import type { IpAiSuggestion } from "../types/intelligence";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";

const SUGGESTION_COLOR: Record<string, string> = {
  increase_forecast:         "#10B981",
  decrease_forecast:         "#F59E0B",
  increase_confidence:       "#3B82F6",
  lower_confidence:          "#94A3B8",
  protect_more_inventory:    "#10B981",
  reduce_buy_recommendation: "#F59E0B",
  review_buyer_request:      "#8B5CF6",
  inspect_return_rate:       "#EF4444",
};

export interface AISuggestionPanelProps {
  suggestions: IpAiSuggestion[];
  skuCodeById: Map<string, string>;
  onAccept: (id: string) => Promise<void>;
  onIgnore: (id: string) => Promise<void>;
}

export default function AISuggestionPanel({ suggestions, skuCodeById, onAccept, onIgnore }: AISuggestionPanelProps) {
  const [showOnlyOpen, setShowOnlyOpen] = useState(true);
  const [filterType, setFilterType] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const types = useMemo(() => Array.from(new Set(suggestions.map((s) => s.suggestion_type))).sort(), [suggestions]);
  const visible = useMemo(() => {
    return suggestions.filter((s) => {
      if (showOnlyOpen && s.accepted_flag != null) return false;
      if (filterType !== "all" && s.suggestion_type !== filterType) return false;
      return true;
    });
  }, [suggestions, showOnlyOpen, filterType]);

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={S.cardTitle}>AI suggestions ({visible.length})</h3>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: PAL.textDim, fontSize: 13 }}>
            <input type="checkbox" checked={showOnlyOpen} onChange={(e) => setShowOnlyOpen(e.target.checked)} />
            Open only
          </label>
          <select style={S.select} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="all">All types</option>
            {types.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
        </div>
      </div>

      {visible.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: PAL.textMuted }}>
          {suggestions.length === 0 ? "No suggestions yet — run the accuracy pass." : "No open suggestions match your filters."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((s) => (
            <div key={s.id} style={{ ...S.infoCell, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{
                  ...S.chip,
                  background: (SUGGESTION_COLOR[s.suggestion_type] ?? PAL.accent) + "33",
                  color: SUGGESTION_COLOR[s.suggestion_type] ?? PAL.accent,
                }}>{s.suggestion_type.replace(/_/g, " ")}</span>
                <span style={{ fontFamily: "monospace", color: PAL.accent }}>
                  {skuCodeById.get(s.sku_id) ?? s.sku_id.slice(0, 8)}
                </span>
                <span style={{ color: PAL.textDim, fontSize: 12 }}>· {formatPeriodCode(s.period_code)}</span>
                <span style={{ marginLeft: "auto", color: PAL.textMuted, fontSize: 12 }}>
                  {s.forecast_type ? `${s.forecast_type} · ` : ""}
                  confidence {s.confidence_score != null ? Math.round(s.confidence_score * 100) : "?"}%
                </span>
              </div>

              <div style={{ marginTop: 6, color: PAL.textDim, fontSize: 13 }}>{s.rationale}</div>

              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                {s.suggested_qty_delta != null && (
                  <span style={{
                    background: PAL.panel, padding: "4px 10px", borderRadius: 6,
                    fontFamily: "monospace",
                    color: s.suggested_qty_delta >= 0 ? PAL.green : PAL.red,
                  }}>
                    {s.suggested_qty_delta >= 0 ? "+" : ""}{formatQty(s.suggested_qty_delta)} units
                  </span>
                )}
                {s.suggested_final_qty != null && (
                  <span style={{
                    background: PAL.panel, padding: "4px 10px", borderRadius: 6,
                    fontFamily: "monospace", color: PAL.text,
                  }}>
                    target {formatQty(s.suggested_final_qty)}
                  </span>
                )}

                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {s.accepted_flag == null ? (
                    <>
                      <button style={S.btnSecondary}
                              onClick={async () => { setBusyId(s.id); try { await onIgnore(s.id); } finally { setBusyId(null); } }}
                              disabled={busyId === s.id}>Ignore</button>
                      <button style={S.btnPrimary}
                              onClick={async () => { setBusyId(s.id); try { await onAccept(s.id); } finally { setBusyId(null); } }}
                              disabled={busyId === s.id}>Accept</button>
                    </>
                  ) : (
                    <span style={{
                      ...S.chip,
                      background: (s.accepted_flag ? PAL.green : PAL.textMuted) + "33",
                      color: s.accepted_flag ? PAL.green : PAL.textMuted,
                    }}>
                      {s.accepted_flag ? "accepted" : "ignored"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ color: PAL.textMuted, fontSize: 11, marginTop: 12 }}>
        Suggestions are heuristic and optional. Rationale + input summary are stored for every row so the reasoning is always inspectable.
      </div>
    </div>
  );
}
