// On-screen "Buyer vs Last Year" report. Pivots the planning rows into a
// per-customer → style → color view across the run's periods, with three
// blocks (SP/LY, TY/Buyer, Comparison). Scope toggle switches between the
// current grid filter and the whole run; Download buttons emit PDF / Excel.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PAL } from "../../components/styles";
import type { IpPlanningGridRow } from "../../types/wholesale";
import {
  buildBuyerVsLyReport, filterOutZeroReportRows, reportComp, reportPct,
  type ReportCustomer, type ReportPeriod,
} from "./buildBuyerVsLyReport";
import { exportBuyerVsLyPdf, exportBuyerVsLyExcel } from "./buyerVsLyReportExports";

// Zero quantities render blank (not "0") so the eye lands only on real numbers.
const qfmt = (n: number): string => (n === 0 ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 0 }));
const pfmt = (frac: number | null): string => (frac == null || frac === 0 ? "" : `${(frac * 100).toFixed(0)}%`);

export function BuyerVsLyReportModal({ fullRows, scopedRows, runName, onClose }: {
  fullRows: IpPlanningGridRow[];
  scopedRows: IpPlanningGridRow[];
  runName: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"filtered" | "full">("filtered");
  const [hideZero, setHideZero] = useState(false);
  const rows = scope === "full" ? fullRows : scopedRows;
  const built = useMemo(() => buildBuyerVsLyReport(rows), [rows]);
  // The view + both exports use the same (optionally zero-filtered) report so a
  // download always matches what's on screen.
  const report = useMemo(() => (hideZero ? filterOutZeroReportRows(built) : built), [built, hideZero]);
  const scopeLabel = scope === "full" ? "Full run" : "Current filters";

  const th: React.CSSProperties = { padding: "6px 10px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#fff", background: PAL.accent, whiteSpace: "nowrap" };
  const thL: React.CSSProperties = { ...th, textAlign: "left" };
  const td: React.CSSProperties = { padding: "5px 10px", textAlign: "right", fontSize: 12, fontFamily: "monospace", color: PAL.text, borderBottom: `1px solid ${PAL.borderFaint}`, whiteSpace: "nowrap" };
  const tdL: React.CSSProperties = { ...td, textAlign: "left", fontFamily: "inherit", color: PAL.textDim };
  const totalTd: React.CSSProperties = { ...td, fontWeight: 700, color: PAL.text, background: `${PAL.accent}14`, borderTop: `2px solid ${PAL.accent}66` };
  const totalTdL: React.CSSProperties = { ...totalTd, textAlign: "left", fontFamily: "inherit" };

  function QtyBlock({ cust, periods, block }: { cust: ReportCustomer; periods: ReportPeriod[]; block: "ly" | "ty" }) {
    return (
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thL}>Style</th>
            <th style={thL}>Color</th>
            {periods.map((p) => <th key={p.period_code} style={th}>{block === "ly" ? p.lyLabel : p.tyLabel}</th>)}
            <th style={th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {cust.styles.map((sty) => sty.colors.map((c, ci) => {
            const arr = block === "ly" ? c.ly : c.ty;
            return (
              <tr key={`${sty.style}|${c.color}`}>
                <td style={tdL}>{ci === 0 ? sty.style : ""}</td>
                <td style={tdL}>{c.color}</td>
                {arr.map((v, i) => <td key={i} style={td}>{qfmt(v)}</td>)}
                <td style={{ ...td, fontWeight: 700 }}>{qfmt(block === "ly" ? c.lyTotal : c.tyTotal)}</td>
              </tr>
            );
          }))}
          <tr>
            <td style={totalTdL} colSpan={2}>TOTAL</td>
            {(block === "ly" ? cust.lyTotals : cust.tyTotals).map((v, i) => <td key={i} style={totalTd}>{qfmt(v)}</td>)}
            <td style={totalTd}>{qfmt(block === "ly" ? cust.lyTotal : cust.tyTotal)}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  function CompBlock({ cust, periods }: { cust: ReportCustomer; periods: ReportPeriod[] }) {
    const compCell = (ty: number, ly: number): React.ReactElement => {
      const d = reportComp(ty, ly);
      return <td style={{ ...td, color: d < 0 ? PAL.red : PAL.text, fontWeight: d !== 0 ? 700 : 400 }}>{qfmt(d)}</td>;
    };
    return (
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thL}>Style</th>
            <th style={thL}>Color</th>
            {periods.map((p) => <th key={p.period_code} style={th} colSpan={2}>{p.tyLabel}</th>)}
            <th style={th} colSpan={2}>Total</th>
          </tr>
          <tr>
            <th style={thL}></th>
            <th style={thL}></th>
            {periods.flatMap((p) => [<th key={`d${p.period_code}`} style={th}>Δ</th>, <th key={`p${p.period_code}`} style={th}>%</th>])}
            <th style={th}>Δ</th>
            <th style={th}>%</th>
          </tr>
        </thead>
        <tbody>
          {cust.styles.map((sty) => sty.colors.map((c, ci) => (
            <tr key={`${sty.style}|${c.color}`}>
              <td style={tdL}>{ci === 0 ? sty.style : ""}</td>
              <td style={tdL}>{c.color}</td>
              {periods.flatMap((_, i) => [compCell(c.ty[i], c.ly[i]), <td key={`p${i}`} style={{ ...td, color: PAL.textMuted }}>{pfmt(reportPct(c.ty[i], c.ly[i]))}</td>])}
              {compCell(c.tyTotal, c.lyTotal)}
              <td style={{ ...td, color: PAL.textMuted }}>{pfmt(reportPct(c.tyTotal, c.lyTotal))}</td>
            </tr>
          )))}
          <tr>
            <td style={totalTdL} colSpan={2}>TOTAL</td>
            {periods.flatMap((_, i) => {
              const d = reportComp(cust.tyTotals[i], cust.lyTotals[i]);
              return [
                <td key={`d${i}`} style={{ ...totalTd, color: d < 0 ? PAL.red : PAL.text }}>{qfmt(d)}</td>,
                <td key={`p${i}`} style={totalTd}>{pfmt(reportPct(cust.tyTotals[i], cust.lyTotals[i]))}</td>,
              ];
            })}
            <td style={{ ...totalTd, color: reportComp(cust.tyTotal, cust.lyTotal) < 0 ? PAL.red : PAL.text }}>{qfmt(reportComp(cust.tyTotal, cust.lyTotal))}</td>
            <td style={totalTd}>{pfmt(reportPct(cust.tyTotal, cust.lyTotal))}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  const btn: React.CSSProperties = { background: "transparent", border: `1px solid ${PAL.border}`, color: PAL.textDim, borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
  const seg = (active: boolean): React.CSSProperties => ({ ...btn, background: active ? PAL.accent : "transparent", color: active ? "#fff" : PAL.textDim, borderColor: active ? PAL.accent : PAL.border });

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 5000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div style={{ width: "min(1400px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", background: PAL.bg, border: `1px solid ${PAL.border}`, borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
        {/* Frozen header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${PAL.border}`, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: PAL.text }}>Buyer vs Last Year</div>
            <div style={{ fontSize: 12, color: PAL.textMuted }}>{runName} · {scopeLabel}</div>
          </div>
          <div style={{ display: "inline-flex", gap: 2, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: 2, background: PAL.panel }}>
            <button type="button" style={seg(scope === "filtered")} onClick={() => setScope("filtered")}>Current filters</button>
            <button type="button" style={seg(scope === "full")} onClick={() => setScope("full")}>Full run</button>
          </div>
          <button
            type="button"
            style={seg(hideZero)}
            onClick={() => setHideZero((v) => !v)}
            title="Hide rows where both last year and this year's Buyer are zero across every month"
          >{hideZero ? "Zero rows: hidden" : "Hide zero rows"}</button>
          <button type="button" style={btn} onClick={() => { void exportBuyerVsLyExcel(report, { runName, scopeLabel }); }}>Download Excel</button>
          <button type="button" style={btn} onClick={() => exportBuyerVsLyPdf(report, { runName, scopeLabel })}>Download PDF</button>
          <button type="button" style={{ ...btn, borderColor: PAL.border, padding: "6px 10px" }} onClick={onClose} title="Close">✕</button>
        </div>
        {/* Scrollable body */}
        <div style={{ overflow: "auto", padding: 18 }}>
          {report.customers.length === 0 ? (
            <div style={{ color: PAL.textMuted, padding: 40, textAlign: "center" }}>
              No rows in scope. {scope === "filtered" ? "Widen the grid filters or switch to Full run." : "This run has no forecast rows yet."}
            </div>
          ) : report.customers.map((cust) => (
            <div key={cust.customer} style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: PAL.accent, marginBottom: 8, borderBottom: `2px solid ${PAL.accent}44`, paddingBottom: 4 }}>{cust.customer}</div>
              <div style={{ display: "grid", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: PAL.textDim, marginBottom: 4 }}>SP/LY — Last Year</div>
                  <div style={{ overflowX: "auto" }}><QtyBlock cust={cust} periods={report.periods} block="ly" /></div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: PAL.textDim, marginBottom: 4 }}>TY / Buyer — This Year</div>
                  <div style={{ overflowX: "auto" }}><QtyBlock cust={cust} periods={report.periods} block="ty" /></div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: PAL.textDim, marginBottom: 4 }}>Comparison — TY − LY</div>
                  <div style={{ overflowX: "auto" }}><CompBlock cust={cust} periods={report.periods} /></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
