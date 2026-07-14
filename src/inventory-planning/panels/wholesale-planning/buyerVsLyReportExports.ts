// PDF + Excel exporters for the Buyer vs Last Year report. Both consume the
// pure BuyerVsLyReport shape (buildBuyerVsLyReport) and lay it out per customer
// as three blocks — SP/LY, TY/Buyer, Comparison (Comp + %).

import { exportPdf, type PdfColumn, type PdfSection } from "../../../shared/pdfExport";
import { newWorkbook, renderStyledAoa, downloadExcelWorkbook, XLP, NUMFMT, type AoaCell } from "../../../shared/excelLogo";
import { reportComp, reportPct, type BuyerVsLyReport, type ReportCustomer } from "./buildBuyerVsLyReport";

function fileStem(runName: string): string {
  return `buyer-vs-ly-${(runName || "run").replace(/[^\w.-]+/g, "_")}`;
}

// ── PDF ────────────────────────────────────────────────────────────────────

export function exportBuyerVsLyPdf(report: BuyerVsLyReport, opts: { runName: string; scopeLabel: string }): void {
  const { periods } = report;
  const sections: PdfSection[] = [];

  const qtyCols = (labelKey: "lyLabel" | "tyLabel"): PdfColumn[] => [
    { header: "Style / Color", key: "label" },
    ...periods.map((p) => ({ header: p[labelKey], key: p.period_code, format: "qty" as const })),
    { header: "Total", key: "total", format: "qty" as const },
  ];

  const codes = periods.map((p) => p.period_code);
  for (const cust of report.customers) {
    // SP/LY block
    sections.push({
      heading: `${cust.customer} — SP/LY (Last Year)`,
      columns: qtyCols("lyLabel"),
      rows: [...qtyRows(cust, "ly", codes), totalRow(cust, "ly", codes)],
    });
    // TY/Buyer block
    sections.push({
      heading: `${cust.customer} — TY / Buyer (This Year)`,
      columns: qtyCols("tyLabel"),
      rows: [...qtyRows(cust, "ty", codes), totalRow(cust, "ty", codes)],
    });
    // Comparison block (Δ + %)
    const compCols: PdfColumn[] = [
      { header: "Style / Color", key: "label" },
      ...periods.flatMap((p) => [
        { header: `${p.tyLabel} Δ`, key: `d_${p.period_code}`, format: "qty" as const },
        { header: "%", key: `p_${p.period_code}`, format: "pct" as const },
      ]),
      { header: "Total Δ", key: "total_d", format: "qty" as const },
      { header: "Total %", key: "total_p", format: "pct" as const },
    ];
    sections.push({
      heading: `${cust.customer} — Comparison (TY − LY)`,
      columns: compCols,
      rows: compRows(cust, periods.map((p) => p.period_code)),
    });
  }

  exportPdf({
    fileName: `${fileStem(opts.runName)}.pdf`,
    title: "Buyer vs Last Year",
    subtitle: `${opts.runName} · ${opts.scopeLabel}`,
    orientation: "landscape",
    sections,
  });
}

function qtyRows(cust: ReportCustomer, block: "ly" | "ty", codes: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const sty of cust.styles) {
    for (const c of sty.colors) {
      const arr = block === "ly" ? c.ly : c.ty;
      const o: Record<string, unknown> = { label: `${c.style} · ${c.color}`, total: block === "ly" ? c.lyTotal : c.tyTotal };
      codes.forEach((code, i) => { o[code] = arr[i]; });
      out.push(o);
    }
  }
  return out;
}

function totalRow(cust: ReportCustomer, block: "ly" | "ty", codes: string[]): Record<string, unknown> {
  const arr = block === "ly" ? cust.lyTotals : cust.tyTotals;
  const o: Record<string, unknown> = { label: "TOTAL", total: block === "ly" ? cust.lyTotal : cust.tyTotal };
  codes.forEach((code, i) => { o[code] = arr[i]; });
  return o;
}

function compRows(cust: ReportCustomer, codes: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (label: string, tyArr: number[], lyArr: number[], tyTot: number, lyTot: number) => {
    const o: Record<string, unknown> = { label };
    codes.forEach((code, i) => {
      o[`d_${code}`] = reportComp(tyArr[i], lyArr[i]);
      o[`p_${code}`] = reportPct(tyArr[i], lyArr[i]);
    });
    o.total_d = reportComp(tyTot, lyTot);
    o.total_p = reportPct(tyTot, lyTot);
    out.push(o);
  };
  for (const sty of cust.styles) {
    for (const c of sty.colors) push(`${c.style} · ${c.color}`, c.ty, c.ly, c.tyTotal, c.lyTotal);
  }
  push("TOTAL", cust.tyTotals, cust.lyTotals, cust.tyTotal, cust.lyTotal);
  return out;
}

// ── Excel (Ring-of-Fire / Tangerine styled, ExcelJS) ────────────────────────
// Mirrors every other Tangerine .xlsx: logo banner, blue header band, bold-blue
// key column, blue total rows, red negatives — via the shared excelLogo engine.

// xlsx-js-style shape consumed by renderStyledAoa's applyAoaStyle.
type Sty = {
  font?: { bold?: boolean; italic?: boolean; sz?: number; color?: { rgb: string } };
  fill?: { fgColor: { rgb: string } };
  alignment?: { horizontal?: "left" | "center" | "right"; vertical?: "center"; wrapText?: boolean };
};
type Align = "left" | "center" | "right";

const S_HEADER = (a: Align): Sty => ({ font: { bold: true, sz: 10, color: { rgb: XLP.HEADER_TEXT } }, fill: { fgColor: { rgb: XLP.HEADER_FILL } }, alignment: { horizontal: a, vertical: "center", wrapText: true } });
const S_KEY: Sty = { font: { bold: true, sz: 10, color: { rgb: XLP.KEY_TEXT } }, alignment: { horizontal: "left", vertical: "center" } };
const S_BODY = (a: Align): Sty => ({ font: { sz: 10, color: { rgb: XLP.BODY_TEXT } }, alignment: { horizontal: a, vertical: "center" } });
const S_NEG: Sty = { font: { bold: true, sz: 10, color: { rgb: XLP.NEG_TEXT } }, alignment: { horizontal: "right", vertical: "center" } };
const S_MUTED: Sty = { font: { sz: 10, color: { rgb: XLP.MUTED_TEXT } }, alignment: { horizontal: "right", vertical: "center" } };
const S_TOTAL = (a: Align): Sty => ({ font: { bold: true, sz: 10, color: { rgb: XLP.TOTAL_TEXT } }, fill: { fgColor: { rgb: XLP.TOTAL_FILL } }, alignment: { horizontal: a, vertical: "center" } });
const S_SUBHEAD: Sty = { font: { bold: true, sz: 11, color: { rgb: XLP.KEY_TEXT } }, alignment: { horizontal: "left", vertical: "center" } };
const S_CUST: Sty = { font: { bold: true, sz: 13, color: { rgb: XLP.HEADER_FILL } }, alignment: { horizontal: "left", vertical: "center" } };

const qtyCell = (v: number, s: Sty): AoaCell => ({ v, s, z: NUMFMT.QTY });
const pctCell = (frac: number | null): AoaCell => (frac == null ? { v: "", s: S_MUTED } : { v: frac, s: S_MUTED, z: NUMFMT.PCT });

export async function exportBuyerVsLyExcel(report: BuyerVsLyReport, opts: { runName: string; scopeLabel: string }): Promise<void> {
  const { periods } = report;
  const nP = periods.length;
  const maxCols = Math.max(nP + 3, nP * 2 + 4); // comparison block is widest
  const aoa: AoaCell[][] = [];
  const blank = () => aoa.push([]);
  const heading = (text: string, s: Sty) => aoa.push([{ v: text, s }]);

  for (const cust of report.customers) {
    heading(cust.customer, S_CUST);
    blank();

    // Shared qty-block renderer (SP/LY or TY/Buyer).
    const qtyBlock = (title: string, label: (p: (typeof periods)[number]) => string, pick: "ly" | "ty") => {
      heading(title, S_SUBHEAD);
      aoa.push([{ v: "Style", s: S_HEADER("left") }, { v: "Color", s: S_HEADER("left") },
        ...periods.map((p) => ({ v: label(p), s: S_HEADER("right") })), { v: "Total", s: S_HEADER("right") }]);
      for (const sty of cust.styles) {
        for (const c of sty.colors) {
          const arr = pick === "ly" ? c.ly : c.ty;
          aoa.push([{ v: c.style, s: S_KEY }, { v: c.color, s: S_BODY("left") },
            ...arr.map((v) => qtyCell(v, S_BODY("right"))), qtyCell(pick === "ly" ? c.lyTotal : c.tyTotal, { ...S_BODY("right"), font: { bold: true, sz: 10, color: { rgb: XLP.BODY_TEXT } } })]);
        }
      }
      const tot = pick === "ly" ? cust.lyTotals : cust.tyTotals;
      aoa.push([{ v: "", s: S_TOTAL("left") }, { v: "TOTAL", s: S_TOTAL("left") },
        ...tot.map((v) => qtyCell(v, S_TOTAL("right"))), qtyCell(pick === "ly" ? cust.lyTotal : cust.tyTotal, S_TOTAL("right"))]);
      blank();
    };
    qtyBlock("SP/LY — Last Year", (p) => p.lyLabel, "ly");
    qtyBlock("TY / Buyer — This Year", (p) => p.tyLabel, "ty");

    // Comparison block (Δ + %).
    heading("Comparison — TY − LY", S_SUBHEAD);
    aoa.push([{ v: "Style", s: S_HEADER("left") }, { v: "Color", s: S_HEADER("left") },
      ...periods.flatMap((p) => [{ v: `${p.tyLabel} Δ`, s: S_HEADER("right") }, { v: "%", s: S_HEADER("right") }]),
      { v: "Total Δ", s: S_HEADER("right") }, { v: "%", s: S_HEADER("right") }]);
    const dCell = (ty: number, ly: number): AoaCell => { const d = reportComp(ty, ly); return { v: d, s: d < 0 ? S_NEG : S_BODY("right"), z: NUMFMT.QTY }; };
    for (const sty of cust.styles) {
      for (const c of sty.colors) {
        aoa.push([{ v: c.style, s: S_KEY }, { v: c.color, s: S_BODY("left") },
          ...periods.flatMap((_p, i) => [dCell(c.ty[i], c.ly[i]), pctCell(reportPct(c.ty[i], c.ly[i]))]),
          dCell(c.tyTotal, c.lyTotal), pctCell(reportPct(c.tyTotal, c.lyTotal))]);
      }
    }
    aoa.push([{ v: "", s: S_TOTAL("left") }, { v: "TOTAL", s: S_TOTAL("left") },
      ...periods.flatMap((_p, i) => {
        const d = reportComp(cust.tyTotals[i], cust.lyTotals[i]);
        return [{ v: d, s: S_TOTAL("right"), z: NUMFMT.QTY } as AoaCell, { v: reportPct(cust.tyTotals[i], cust.lyTotals[i]) ?? "", s: S_TOTAL("right"), z: NUMFMT.PCT } as AoaCell];
      }),
      { v: reportComp(cust.tyTotal, cust.lyTotal), s: S_TOTAL("right"), z: NUMFMT.QTY },
      { v: reportPct(cust.tyTotal, cust.lyTotal) ?? "", s: S_TOTAL("right"), z: NUMFMT.PCT }]);
    blank();
    blank();
  }

  const wb = newWorkbook();
  const cols = [16, 16, ...Array(Math.max(0, maxCols - 2)).fill(11)];
  renderStyledAoa(wb, "Buyer vs LY", aoa, {
    banner: { title: "Buyer vs Last Year", subtitle: `${opts.runName} · ${opts.scopeLabel}`, cols: maxCols, logoWidth: 200 },
    cols,
  });
  await downloadExcelWorkbook(wb, `${fileStem(opts.runName)}.xlsx`);
}
