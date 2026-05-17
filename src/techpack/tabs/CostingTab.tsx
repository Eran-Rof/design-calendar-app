// Costing tab extracted from TechPack.tsx. Pure presentational
// component — every number flows in via props (the tech pack's
// `costing` block), every edit flows back out via updateSelected.
//
// The math itself (duty, landed cost, margin, margin-tier color)
// lives in ../calc.ts and is already covered by 21 unit tests; this
// component just wires those helpers to the editable form.

import type { TechPack, Costing } from "../types";
import { fmtCurrency } from "../utils";
import { recomputeCosting, marginTierColor } from "../calc";
import S from "../styles";

export interface CostingTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
}

export function CostingTab({ tp, updateSelected }: CostingTabProps) {
  const c = tp.costing;

  const recalc = (updates: Partial<Costing>) => {
    updateSelected({ costing: recomputeCosting(c, updates) });
  };

  const marginColor = marginTierColor(c.margin);

  return (
    <>
      <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Costing Breakdown</h3>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Left: Inputs */}
        <div>
          <div style={{ ...S.card, padding: 16, marginBottom: 0 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>FOB Price ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.fob || ""} onChange={e => recalc({ fob: parseFloat(e.target.value) || 0 })} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Duty Rate (%)</label>
              <input style={S.input} type="number" step="0.1" value={c.dutyRate || ""} onChange={e => recalc({ dutyRate: parseFloat(e.target.value) || 0 })} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Duty Amount ($)</label>
              <div style={{ ...S.input, background: "#1E293B", color: "#94A3B8" }}>{fmtCurrency(c.duty)}</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Freight ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.freight || ""} onChange={e => recalc({ freight: parseFloat(e.target.value) || 0 })} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Insurance ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.insurance || ""} onChange={e => recalc({ insurance: parseFloat(e.target.value) || 0 })} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Other Costs ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.otherCosts || ""} onChange={e => recalc({ otherCosts: parseFloat(e.target.value) || 0 })} />
            </div>
          </div>
        </div>

        {/* Right: Summary */}
        <div>
          <div style={{ ...S.card, padding: 16, marginBottom: 16 }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Landed Cost</div>
              <div style={{ color: "#F1F5F9", fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>{fmtCurrency(c.landedCost)}</div>
              <div style={{ color: "#6B7280", fontSize: 11, marginTop: 4 }}>FOB + Duty + Freight + Insurance + Other</div>
            </div>

            <div style={{ borderTop: "1px solid #334155", paddingTop: 12, marginBottom: 12 }}>
              <label style={S.label}>Wholesale Price ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.wholesalePrice || ""} onChange={e => recalc({ wholesalePrice: parseFloat(e.target.value) || 0 })} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Retail Price ($)</label>
              <input style={S.input} type="number" step="0.01" value={c.retailPrice || ""} onChange={e => recalc({ retailPrice: parseFloat(e.target.value) || 0 })} />
            </div>

            {/* Margin Indicator */}
            <div style={{ background: "#0F172A", borderRadius: 12, padding: 16, textAlign: "center" }}>
              <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Margin</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: marginColor, fontFamily: "monospace" }}>{c.margin.toFixed(1)}%</div>
              <div style={{ width: "100%", height: 8, background: "#334155", borderRadius: 4, overflow: "hidden", marginTop: 12 }}>
                <div style={{ width: `${Math.min(c.margin, 100)}%`, height: "100%", background: marginColor, borderRadius: 4, transition: "width 0.3s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#6B7280" }}>
                <span>0%</span>
                <span style={{ color: "#EF4444" }}>30%</span>
                <span style={{ color: "#F59E0B" }}>50%</span>
                <span>100%</span>
              </div>
            </div>
          </div>

          <div>
            <label style={S.label}>Costing Notes</label>
            <textarea style={{ ...S.textarea, minHeight: 60 }} value={c.notes} onChange={e => recalc({ notes: e.target.value })} placeholder="Notes about costing..." />
          </div>
        </div>
      </div>
    </>
  );
}
