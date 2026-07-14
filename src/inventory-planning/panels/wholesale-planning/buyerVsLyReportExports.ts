// PDF + Excel exporters for the Buyer vs Last Year report. Both consume the
// pure BuyerVsLyReport shape (buildBuyerVsLyReport) and lay it out per customer
// as three blocks — SP/LY, TY/Buyer, Comparison (Comp + %).

import * as XLSX from "xlsx";
import { exportPdf, type PdfColumn, type PdfSection } from "../../../shared/pdfExport";
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

// ── Excel ──────────────────────────────────────────────────────────────────

type Cell = string | number | { v: number; t: "n"; z: string } | null;

export function exportBuyerVsLyExcel(report: BuyerVsLyReport, opts: { runName: string; scopeLabel: string }): void {
  const { periods } = report;
  const aoa: Cell[][] = [];
  aoa.push(["Buyer vs Last Year", opts.runName]);
  aoa.push([opts.scopeLabel]);
  aoa.push([]);

  const pct = (frac: number | null): Cell => (frac == null ? "" : { v: frac, t: "n", z: "0%" });

  for (const cust of report.customers) {
    aoa.push(["Customer", cust.customer]);
    aoa.push([]);

    // SP/LY block
    aoa.push(["SP/LY (Last Year)"]);
    aoa.push(["Style", "Color", ...periods.map((p) => p.lyLabel), "TOTAL"]);
    for (const sty of cust.styles)
      for (const c of sty.colors) aoa.push([c.style, c.color, ...c.ly, c.lyTotal]);
    aoa.push(["", "TOTAL", ...cust.lyTotals, cust.lyTotal]);
    aoa.push([]);

    // TY/Buyer block
    aoa.push(["TY / Buyer (This Year)"]);
    aoa.push(["Style", "Color", ...periods.map((p) => p.tyLabel), "TOTAL"]);
    for (const sty of cust.styles)
      for (const c of sty.colors) aoa.push([c.style, c.color, ...c.ty, c.tyTotal]);
    aoa.push(["", "TOTAL", ...cust.tyTotals, cust.tyTotal]);
    aoa.push([]);

    // Comparison block
    aoa.push(["Comparison (TY − LY)"]);
    aoa.push(["Style", "Color", ...periods.flatMap((p) => [p.tyLabel, "%"]), "TOTAL", "%"]);
    for (const sty of cust.styles)
      for (const c of sty.colors) {
        const cells: Cell[] = [c.style, c.color];
        periods.forEach((_, i) => { cells.push(reportComp(c.ty[i], c.ly[i]), pct(reportPct(c.ty[i], c.ly[i]))); });
        cells.push(reportComp(c.tyTotal, c.lyTotal), pct(reportPct(c.tyTotal, c.lyTotal)));
        aoa.push(cells);
      }
    {
      const cells: Cell[] = ["", "TOTAL"];
      periods.forEach((_, i) => { cells.push(reportComp(cust.tyTotals[i], cust.lyTotals[i]), pct(reportPct(cust.tyTotals[i], cust.lyTotals[i]))); });
      cells.push(reportComp(cust.tyTotal, cust.lyTotal), pct(reportPct(cust.tyTotal, cust.lyTotal)));
      aoa.push(cells);
    }
    aoa.push([]);
    aoa.push([]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa as (string | number)[][]);
  ws["!cols"] = [{ wch: 16 }, { wch: 16 }, ...periods.flatMap(() => [{ wch: 10 }, { wch: 7 }]), { wch: 10 }, { wch: 7 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Buyer vs LY");
  XLSX.writeFile(wb, `${fileStem(opts.runName)}.xlsx`);
}
