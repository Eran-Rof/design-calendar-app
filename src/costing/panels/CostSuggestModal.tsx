// Costing Module — AI cost co-pilot modal.
//
// Opened from a grid row's right-click menu ("AI cost suggestion"). Fetches a
// grounded cost/sell/margin recommendation from the suggest endpoint (which
// reads the line's LY/T3 comp + PO purchase history), shows the rationale and
// the signals it used, and lets the operator APPLY the numbers into the line.
//
// Advisory only: nothing is written until the operator clicks Apply, which calls
// back into the grid's normal updateLine path (so quoted-line revision prompts,
// margin recompute, autosave all still fire).

import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { suggestLineCosts, type CostSuggestion } from "../services/costingApi";
import type { CostingLine } from "../types";

const C = {
  overlay: "rgba(2,6,23,0.66)",
  card: "#1E293B",
  border: "#334155",
  borderStrong: "#475569",
  text: "#E2E8F0",
  subtle: "#94A3B8",
  accent: "#60A5FA",
  good: "#6EE7B7",
  bad: "#F87171",
  bandBg: "#0F172A",
};

const money = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
const pct = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";

interface Props {
  line: CostingLine;
  /** Apply a patch to the line (grid's updateLine path). */
  onApply: (patch: Partial<CostingLine>) => void | Promise<void>;
  onClose: () => void;
}

export default function CostSuggestModal({ line, onApply, onClose }: Props) {
  const [data, setData] = useState<CostSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrl.current = new AbortController();
    setLoading(true);
    setError(null);
    suggestLineCosts(line.id, ctrl.current.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") setError((e as Error).message); })
      .finally(() => setLoading(false));
    return () => ctrl.current?.abort();
  }, [line.id]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const costField: keyof CostingLine = data?.is_ddp ? "target_cost" : "fob_cost";
  const suggestedCost = data?.is_ddp ? data?.suggested_target_cost : data?.suggested_fob_cost;
  const costLabel = data?.is_ddp ? "Target DDP cost" : "FOB cost";

  const applyAll = async () => {
    if (!data) return;
    const patch: Partial<CostingLine> = {};
    if (typeof suggestedCost === "number") (patch as Record<string, number>)[costField] = suggestedCost;
    if (typeof data.suggested_sell_target === "number") patch.sell_target = data.suggested_sell_target;
    if (Object.keys(patch).length) await onApply(patch);
    setApplied(true);
  };
  const applyOne = async (patch: Partial<CostingLine>) => {
    await onApply(patch);
    setApplied(true);
  };

  const confPct = data?.confidence != null ? Math.round(data.confidence * 100) : null;
  const confColor = confPct == null ? C.subtle : confPct >= 66 ? C.good : confPct >= 40 ? "#FBBF24" : C.bad;

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
          width: "min(560px, 95vw)", maxHeight: "88vh", overflow: "auto",
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)", color: C.text,
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>AI cost suggestion</div>
            <div style={{ fontSize: 12, color: C.subtle }}>
              {line.style_code || "(no style)"}{line.color ? ` · ${line.color}` : ""}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={iconBtn}>✕</button>
        </div>

        <div style={{ padding: 18 }}>
          {loading && <div style={{ color: C.subtle, fontSize: 14 }}>Analyzing sales + PO history…</div>}
          {error && <div style={{ color: C.bad, fontSize: 14 }}>{error}</div>}

          {!loading && !error && data && data.insufficient_data && (
            <div style={{ color: C.subtle, fontSize: 14, lineHeight: 1.5 }}>{data.rationale}</div>
          )}

          {!loading && !error && data && !data.insufficient_data && (
            <>
              {/* Confidence */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: C.subtle }}>Confidence</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: confColor }}>
                  {confPct != null ? `${confPct}%` : "—"}
                </span>
                <span style={{ fontSize: 11, color: C.subtle, marginLeft: "auto" }}>{data.model}</span>
              </div>

              {/* Suggested values vs current */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 14 }}>
                <thead>
                  <tr style={{ color: C.subtle, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                    <th style={th}> </th>
                    <th style={{ ...th, textAlign: "right" }}>Current</th>
                    <th style={{ ...th, textAlign: "right" }}>Suggested</th>
                    <th style={th}> </th>
                  </tr>
                </thead>
                <tbody>
                  <Row
                    label={costLabel}
                    current={money(line[costField] as number | null)}
                    suggested={money(suggestedCost)}
                    canApply={typeof suggestedCost === "number"}
                    onApply={() => applyOne({ [costField]: suggestedCost } as Partial<CostingLine>)}
                  />
                  <Row
                    label="Sell target"
                    current={money(line.sell_target)}
                    suggested={money(data.suggested_sell_target)}
                    canApply={typeof data.suggested_sell_target === "number"}
                    onApply={() => applyOne({ sell_target: data.suggested_sell_target })}
                  />
                  <Row
                    label="Gross margin"
                    current={pct(typeof line.margin_pct === "number" ? line.margin_pct : null)}
                    suggested={pct(data.suggested_margin_pct)}
                    canApply={false}
                    hint="derived"
                  />
                </tbody>
              </table>

              {/* Rationale */}
              {data.rationale && (
                <div style={{ background: C.bandBg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.subtle, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Why</div>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>{data.rationale}</div>
                </div>
              )}

              {/* Signals */}
              {data.signals.length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.subtle, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>Signals used</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.text, lineHeight: 1.6 }}>
                    {data.signals.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}

              <div style={{ fontSize: 10.5, color: C.subtle, marginTop: 12, fontStyle: "italic" }}>
                AI-generated from your sales + PO history. Review before applying — nothing is saved until you click Apply.
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnGhost}>{applied ? "Done" : "Cancel"}</button>
          {!loading && !error && data && !data.insufficient_data && (
            <button onClick={applyAll} style={btnPrimary}>Apply cost + sell</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, current, suggested, canApply, onApply, hint }: {
  label: string; current: string; suggested: string; canApply: boolean; onApply?: () => void; hint?: string;
}) {
  return (
    <tr style={{ borderTop: `1px solid ${C.border}` }}>
      <td style={{ ...td, fontWeight: 600 }}>{label}</td>
      <td style={{ ...td, textAlign: "right", color: C.subtle }}>{current}</td>
      <td style={{ ...td, textAlign: "right", fontWeight: 700, color: C.good }}>{suggested}</td>
      <td style={{ ...td, textAlign: "right", width: 64 }}>
        {canApply ? (
          <button onClick={onApply} style={applyBtn}>Apply</button>
        ) : (
          <span style={{ fontSize: 10, color: C.subtle }}>{hint || ""}</span>
        )}
      </td>
    </tr>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", fontWeight: 600 };
const td: React.CSSProperties = { padding: "8px 6px", verticalAlign: "middle" };
const iconBtn: React.CSSProperties = {
  background: "transparent", border: "none", color: C.subtle, fontSize: 14, cursor: "pointer", padding: 4, lineHeight: 1,
};
const applyBtn: React.CSSProperties = {
  background: "transparent", border: `1px solid ${C.accent}`, color: C.accent,
  borderRadius: 5, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  background: "transparent", border: `1px solid ${C.borderStrong}`, color: C.text,
  borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  background: C.accent, border: `1px solid ${C.accent}`, color: "#0F172A",
  borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
};
