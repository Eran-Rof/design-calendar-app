// Costing Module — AI size-curve modal.
//
// Opened from a grid row's right-click menu ("AI size curve"). Shows the
// predicted per-size unit split for the line's style, learned from the style's
// own 24-month sales history and applied to the line's order qty. Informational
// only (costing lines are color-grain) — a horizontal bar per size with % and
// suggested units, plus a plain-English read and any stockout-suppressed flags.

import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { forecastSizeCurve, type SizeCurveForecast } from "../services/costingApi";
import type { CostingLine } from "../types";
import ExportButton from "../../tanda/exports/ExportButton";

const C = {
  overlay: "rgba(2,6,23,0.66)",
  card: "#1E293B",
  border: "#334155",
  borderStrong: "#475569",
  text: "#E2E8F0",
  subtle: "#94A3B8",
  accent: "#60A5FA",
  bar: "#3B82F6",
  barTrack: "#0F172A",
  flag: "#FBBF24",
  bandBg: "#0F172A",
};

interface Props {
  line: CostingLine;
  onClose: () => void;
}

export default function SizeCurveModal({ line, onClose }: Props) {
  const [data, setData] = useState<SizeCurveForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrl.current = new AbortController();
    setLoading(true);
    setError(null);
    forecastSizeCurve(line.id, ctrl.current.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") setError((e as Error).message); })
      .finally(() => setLoading(false));
    return () => ctrl.current?.abort();
  }, [line.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxPct = data?.sizes.length ? Math.max(...data.sizes.map((s) => s.pct), 1) : 1;
  const hasQty = !!data?.target_qty;

  return ReactDOM.createPortal(
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, background: C.overlay, zIndex: 4000,
        display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(580px, 95vw)", maxHeight: "88vh", overflow: "auto",
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)", color: C.text,
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>AI size curve</div>
            <div style={{ fontSize: 12, color: C.subtle }}>
              {line.style_code || "(no style)"}{line.color ? ` · ${line.color}` : ""}
              {line.size_scale_label ? ` · ${line.size_scale_label}` : ""}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={iconBtn}>✕</button>
        </div>

        <div style={{ padding: 18 }}>
          {loading && <div style={{ color: C.subtle, fontSize: 14 }}>Learning the size curve from sales history…</div>}
          {error && <div style={{ color: "#F87171", fontSize: 14 }}>{error}</div>}

          {!loading && !error && data && data.insufficient_data && (
            <div style={{ color: C.subtle, fontSize: 14, lineHeight: 1.5 }}>
              {data.narrative || "Not enough sales history to learn a size curve for this style."}
            </div>
          )}

          {!loading && !error && data && !data.insufficient_data && (
            <>
              <div style={{ fontSize: 12, color: C.subtle, marginBottom: 14 }}>
                Based on <strong style={{ color: C.text }}>{data.total_units_analyzed.toLocaleString()}</strong> units sold over 24 months
                {hasQty && <> · split of <strong style={{ color: C.text }}>{data.target_qty!.toLocaleString()}</strong> order units</>}
              </div>

              {/* Bars */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {data.sizes.map((s) => (
                  <div key={s.size} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 56, textAlign: "right", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      {s.size}
                    </div>
                    <div style={{ flex: 1, background: C.barTrack, borderRadius: 4, height: 22, position: "relative", overflow: "hidden" }}>
                      <div style={{
                        width: `${Math.max((s.pct / maxPct) * 100, 2)}%`, height: "100%",
                        background: s.flag ? C.flag : C.bar, borderRadius: 4, transition: "width .2s",
                      }} />
                      <span style={{ position: "absolute", left: 8, top: 0, lineHeight: "22px", fontSize: 11, fontWeight: 700, color: "#fff" }}>
                        {s.pct}%
                      </span>
                    </div>
                    {hasQty && (
                      <div style={{ width: 64, textAlign: "right", fontSize: 13, fontWeight: 700, color: C.accent, flexShrink: 0 }}>
                        {(s.suggested_qty ?? 0).toLocaleString()}
                      </div>
                    )}
                    {s.flag && <span title={s.flag} style={{ fontSize: 12, flexShrink: 0, color: "#F59E0B", fontWeight: 700 }}>flag</span>}
                  </div>
                ))}
              </div>

              {/* Flags detail */}
              {data.sizes.some((s) => s.flag) && (
                <div style={{ marginBottom: 12 }}>
                  {data.sizes.filter((s) => s.flag).map((s) => (
                    <div key={s.size} style={{ fontSize: 12, color: C.flag, marginBottom: 2 }}>
                      <strong>{s.size}:</strong> {s.flag}
                    </div>
                  ))}
                </div>
              )}

              {/* Narrative */}
              {data.narrative && (
                <div style={{ background: C.bandBg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.subtle, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Read</div>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>{data.narrative}</div>
                </div>
              )}

              <div style={{ fontSize: 10.5, color: C.subtle, marginTop: 12, fontStyle: "italic" }}>
                Informational — costing lines are color-grain, so this is a buy-planning guide, not saved to the line.
              </div>
            </>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {data && !data.insufficient_data && data.sizes.length > 0 && (
            <ExportButton
              rows={data.sizes.map((s) => ({
                size: s.size,
                pct_of_demand: s.pct,
                historical_units: s.units,
                suggested_qty: s.suggested_qty ?? "",
                flag: s.flag ?? "",
              }))}
              columns={[
                { key: "size", header: "SIZE" },
                { key: "pct_of_demand", header: "% OF DEMAND" },
                { key: "historical_units", header: "HISTORICAL UNITS (24M)" },
                { key: "suggested_qty", header: "SUGGESTED QTY" },
                { key: "flag", header: "FLAG" },
              ]}
              filename={`size-curve-${data.style_code || "style"}`}
              sheetName="Size Curve"
            />
          )}
          <button onClick={onClose} style={btnGhost}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent", border: "none", color: C.subtle, fontSize: 14, cursor: "pointer", padding: 4, lineHeight: 1,
};
const btnGhost: React.CSSProperties = {
  background: "transparent", border: `1px solid ${C.borderStrong}`, color: C.text,
  borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer",
};
