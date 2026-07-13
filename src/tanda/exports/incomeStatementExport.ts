// src/tanda/exports/incomeStatementExport.ts
//
// Best-in-class (NetSuite / QuickBooks) Income-Statement export — xlsx + PDF.
//
// The generic <ExportButton> dumps a flat grid; a P&L that a CFO hands to a bank
// needs the STATEMENT shape:
//   • a report header block — company, "Income Statement", the period, basis,
//     and the "as printed" date,
//   • the banded body — indented section headers → sub-accounts → bold subtotals,
//     with the running bands (Net Sales, Gross Profit, Net Operating Income,
//     Net Income) ruled + bold,
//   • right-aligned currency with thousands separators and PARENTHESES for
//     negatives, an optional "% of Net Sales" column, and the monthly columns
//     (Month | Month | … | Total) in range mode,
//   • a single blue accent, the header + account-label column frozen.
//
// The panel builds a StatementModel (below) from the same numbers it renders;
// this module turns that into a styled ExcelJS workbook (via renderStyledAoa)
// and a print-window PDF. Self-contained: no new deps, reuses the shared logo.

import {
  newWorkbook, renderStyledAoa, downloadExcelWorkbook,
  type AoaCell,
} from "../../shared/excelLogo";
import { ROF_LOGO_DATA_URL } from "../../shared/assets/rofLogo";

// ── Palette (hex, no #) — single blue accent ─────────────────────────────────
const ACCENT = "1F497D";      // banner / rules / band text
const SECTION_FILL = "DCE6F1"; // section header band
const BAND_FILL = "C6D9F1";    // running subtotal band (Net Sales, Gross Profit…)
const STRONG_FILL = "B7CDEA";  // Net Sales / Net Income (strong bands)
const BODY_TEXT = "1A202C";
const MUTED_TEXT = "5F5E5A";
const RULE = "8FAADC";

// A negatives-in-parentheses money format ($ literal). % as 0.0%.
const NUMFMT_MONEY = '$#,##0.00_);($#,##0.00)';
const NUMFMT_PCT = "0.0%";

export type StmtLineKind =
  | "section"        // section header (Revenue, COGS, Operating Expenses…) — label only
  | "group"          // parent-account group header (indented) — carries values
  | "account"        // sub-account / standalone account — carries values
  | "subtotal"       // group subtotal or "Total <Section>" — bold, top rule
  | "band"           // running band (Gross Profit, Net Operating Income) — bold, rule
  | "band_strong"    // headline band (Net Sales, Net Income) — bold, strong rule
  | "spacer";        // blank row

export type StmtLine = {
  kind: StmtLineKind;
  label: string;
  code?: string | null;
  indent?: 0 | 1 | 2;
  byMonth?: Record<string, number>; // cents (already sign-applied)
  total?: number;                   // cents (already sign-applied)
  hasValues?: boolean;              // whether to render the amount columns
};

export type StmtMonth = { key: string; label: string };

export type StatementModel = {
  company: string;      // "Ring of Fire"
  reportTitle: string;  // "Income Statement"
  periodLabel: string;  // "January 1 – July 13, 2026"
  basisLabel: string;   // "Accrual basis" | "Cash basis"
  printedLabel: string; // "Printed Jul 13, 2026 3:04 PM"
  months: StmtMonth[];  // ordered month columns; [] in single-period mode
  showPct: boolean;
  hideAccountNum: boolean;
  netSalesBase: number; // cents — denominator for % of Net Sales
  lines: StmtLine[];
};

const cents = (c: number | undefined | null): number => (Number(c) || 0) / 100;

// ── Display-string money (parentheses for negatives) for the PDF path ────────
function moneyStr(c: number | undefined | null): string {
  const n = cents(c);
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${abs})` : `$${abs}`;
}
function pctStr(totalCents: number | undefined | null, baseCents: number): string {
  if (!baseCents) return "";
  return `${(((Number(totalCents) || 0) / baseCents) * 100).toFixed(1)}%`;
}

// Number of leading label columns (Code + Account, or just Account).
function leadCols(m: StatementModel): number { return m.hideAccountNum ? 1 : 2; }
function colCount(m: StatementModel): number {
  return leadCols(m) + m.months.length + 1 /* Total */ + (m.showPct ? 1 : 0);
}

// ── xlsx-js-style cell style factories (consumed by renderStyledAoa) ─────────
type Sty = AoaCell["s"];
function font(opts: { bold?: boolean; italic?: boolean; sz?: number; color?: string } = {}): NonNullable<Sty>["font"] {
  return { bold: opts.bold, italic: opts.italic, sz: opts.sz ?? 10, name: "Calibri", color: { rgb: opts.color ?? BODY_TEXT } };
}
function fill(hex: string): NonNullable<Sty>["fill"] { return { fgColor: { rgb: hex } }; }
function topRule(style: "thin" | "medium", color = ACCENT) { return { top: { style, color: { rgb: color } } }; }

// A money value cell (right-aligned, parentheses numFmt) or blank.
function moneyCell(c: number | undefined | null, s: Sty, has: boolean): AoaCell {
  if (!has) return { v: "", s };
  return { v: cents(c), t: "n", z: NUMFMT_MONEY, s: { ...s, alignment: { horizontal: "right", vertical: "center" }, numFmt: NUMFMT_MONEY } };
}
function pctCell(totalCents: number | undefined | null, base: number, s: Sty, has: boolean): AoaCell {
  if (!has || !base) return { v: "", s };
  return { v: (Number(totalCents) || 0) / base, t: "n", z: NUMFMT_PCT, s: { ...s, alignment: { horizontal: "right", vertical: "center" }, numFmt: NUMFMT_PCT } };
}

// Per-kind visual spec.
function kindSpec(kind: StmtLineKind): { fillHex?: string; bold: boolean; italic?: boolean; color: string; rule?: "thin" | "medium"; strong?: boolean } {
  switch (kind) {
    case "section": return { fillHex: SECTION_FILL, bold: true, color: ACCENT };
    case "group": return { bold: true, color: BODY_TEXT };
    case "account": return { bold: false, color: BODY_TEXT };
    case "subtotal": return { bold: true, color: BODY_TEXT, rule: "thin" };
    case "band": return { fillHex: BAND_FILL, bold: true, color: ACCENT, rule: "medium" };
    case "band_strong": return { fillHex: STRONG_FILL, bold: true, color: ACCENT, rule: "medium", strong: true };
    default: return { bold: false, color: BODY_TEXT };
  }
}

// ── Build the ExcelJS workbook ───────────────────────────────────────────────
export function buildIncomeStatementWorkbook(m: StatementModel) {
  const wb = newWorkbook();
  const cols = colCount(m);
  const lead = leadCols(m);
  const aoa: AoaCell[][] = [];
  const mergeList: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];

  const centerHeader = (text: string, opts: { sz: number; bold?: boolean; italic?: boolean; color?: string }): AoaCell[] => {
    const row: AoaCell[] = [{ v: text, s: { font: font({ bold: opts.bold, italic: opts.italic, sz: opts.sz, color: opts.color }), alignment: { horizontal: "center", vertical: "center" } } }];
    for (let i = 1; i < cols; i++) row.push({ v: "", s: {} });
    mergeList.push({ s: { r: aoa.length, c: 0 }, e: { r: aoa.length, c: cols - 1 } });
    return row;
  };

  // Report header block (the logo goes in the banner above these).
  aoa.push(centerHeader(m.reportTitle, { sz: 15, bold: true, color: ACCENT }));
  aoa.push(centerHeader(m.periodLabel, { sz: 11, bold: true, color: BODY_TEXT }));
  aoa.push(centerHeader(`${m.basisLabel}  ·  ${m.printedLabel}`, { sz: 9, italic: true, color: MUTED_TEXT }));
  aoa.push(new Array(cols).fill({ v: "", s: {} })); // spacer

  // Column header row.
  const headerRowIdx = aoa.length;
  const hstyle = (align: "left" | "right"): Sty => ({
    font: font({ bold: true, sz: 10, color: "FFFFFF" }),
    fill: fill(ACCENT),
    alignment: { horizontal: align, vertical: "center", wrapText: true },
  });
  const hdr: AoaCell[] = [];
  if (!m.hideAccountNum) hdr.push({ v: "Account #", s: hstyle("left") });
  hdr.push({ v: "Account", s: hstyle("left") });
  for (const mc of m.months) hdr.push({ v: mc.label, s: hstyle("right") });
  hdr.push({ v: m.months.length ? "Total" : "Amount", s: hstyle("right") });
  if (m.showPct) hdr.push({ v: "% of Net Sales", s: hstyle("right") });
  aoa.push(hdr);

  // Body lines.
  for (const line of m.lines) {
    if (line.kind === "spacer") { aoa.push(new Array(cols).fill({ v: "", s: {} })); continue; }
    const spec = kindSpec(line.kind);
    const rowFill = spec.fillHex ? fill(spec.fillHex) : undefined;
    const border = spec.rule ? topRule(spec.rule) : undefined;
    const labelFont = font({ bold: spec.bold, italic: spec.italic, sz: spec.strong ? 11 : 10, color: spec.color });
    const cellBase: Sty = { fill: rowFill, border };
    const indent = line.indent ?? 0;
    const row: AoaCell[] = [];

    // Code column (only when account numbers shown).
    if (!m.hideAccountNum) {
      row.push({ v: line.code ?? "", s: { ...cellBase, font: font({ bold: spec.bold, sz: 9, color: MUTED_TEXT }), alignment: { horizontal: "left", vertical: "center" } } });
    }
    // Account-label column — indentation via left-pad spaces (Excel has no
    // per-cell text indent in this style shape, and it keeps the PDF identical).
    const pad = "    ".repeat(indent);
    row.push({ v: `${pad}${line.label}`, s: { ...cellBase, font: labelFont, alignment: { horizontal: "left", vertical: "center", indent } } });

    const has = line.hasValues !== false && (line.kind !== "section");
    const valFont: Sty = { ...cellBase, font: labelFont };
    for (const mc of m.months) row.push(moneyCell(line.byMonth?.[mc.key], valFont, has));
    row.push(moneyCell(line.total, valFont, has));
    if (m.showPct) row.push(pctCell(line.total, m.netSalesBase, { ...cellBase, font: font({ bold: spec.bold, sz: 9, color: MUTED_TEXT }) }, has));
    aoa.push(row);
  }

  // Column widths: label col wide, code narrow, money cols medium.
  const widths: number[] = [];
  if (!m.hideAccountNum) widths.push(11);
  widths.push(38);
  for (let i = 0; i < m.months.length; i++) widths.push(15);
  widths.push(16);
  if (m.showPct) widths.push(13);

  renderStyledAoa(wb, m.reportTitle.slice(0, 28) || "Income Statement", aoa, {
    banner: { title: m.company, cols, logoWidth: 200 },
    merges: mergeList,
    cols: widths,
    // Freeze the header block + column-header row, and the label column(s).
    freeze: { xSplit: lead, ySplit: headerRowIdx + 1 },
  });
  return wb;
}

export async function downloadIncomeStatementXlsx(m: StatementModel, filename: string) {
  const wb = buildIncomeStatementWorkbook(m);
  await downloadExcelWorkbook(wb, `${filename}.xlsx`);
}

// ── PDF (print window) — the same statement, HTML-rendered ───────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildIncomeStatementHtml(m: StatementModel): string {
  const moneyCols = m.months.length + 1 + (m.showPct ? 1 : 0);
  const colGroup =
    (m.hideAccountNum ? "" : `<col style="width:70px" />`) +
    `<col />` +
    m.months.map(() => `<col style="width:96px" />`).join("") +
    `<col style="width:104px" />` +
    (m.showPct ? `<col style="width:80px" />` : "");

  const headTh =
    (m.hideAccountNum ? "" : `<th class="lc">Account #</th>`) +
    `<th class="lc">Account</th>` +
    m.months.map((mc) => `<th class="rc">${escapeHtml(mc.label)}</th>`).join("") +
    `<th class="rc">${m.months.length ? "Total" : "Amount"}</th>` +
    (m.showPct ? `<th class="rc">% of Net Sales</th>` : "");

  const bodyRows = m.lines.map((line) => {
    if (line.kind === "spacer") return `<tr class="spacer"><td colspan="${(m.hideAccountNum ? 1 : 2) + moneyCols}">&nbsp;</td></tr>`;
    const spec = kindSpec(line.kind);
    const has = line.hasValues !== false && line.kind !== "section";
    const indentPx = (line.indent ?? 0) * 18;
    const cls = [
      "row",
      line.kind === "section" ? "section" : "",
      line.kind === "band" ? "band" : "",
      line.kind === "band_strong" ? "band strong" : "",
      line.kind === "subtotal" ? "subtotal" : "",
      spec.bold ? "b" : "",
    ].filter(Boolean).join(" ");
    const codeCell = m.hideAccountNum ? "" : `<td class="code">${escapeHtml(line.code ?? "")}</td>`;
    const nameCell = `<td class="name" style="padding-left:${8 + indentPx}px">${escapeHtml(line.label)}</td>`;
    const moneyCells = has
      ? [...m.months.map((mc) => `<td class="num">${moneyStr(line.byMonth?.[mc.key])}</td>`), `<td class="num">${moneyStr(line.total)}</td>`].join("")
      : [...m.months.map(() => `<td></td>`), `<td></td>`].join("");
    const pctCell = m.showPct ? (has ? `<td class="num pct">${pctStr(line.total, m.netSalesBase)}</td>` : `<td></td>`) : "";
    return `<tr class="${cls}">${codeCell}${nameCell}${moneyCells}${pctCell}</tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${escapeHtml(m.reportTitle)} — ${escapeHtml(m.company)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Calibri, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 28px; color: #1a202c; }
  .rof-logo { height: 34px; display: block; margin: 0 auto 6px; }
  .company { text-align: center; font-size: 18px; font-weight: 700; color: #1F497D; }
  .title { text-align: center; font-size: 15px; font-weight: 700; margin-top: 2px; }
  .period { text-align: center; font-size: 12px; margin-top: 2px; }
  .meta { text-align: center; font-size: 10px; color: #5f5e5a; font-style: italic; margin: 2px 0 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { padding: 3px 8px; }
  thead th { background: #1F497D; color: #fff; font-weight: 600; }
  thead th.lc { text-align: left; }
  thead th.rc { text-align: right; }
  td.code { color: #5f5e5a; font-size: 10px; white-space: nowrap; }
  td.name { text-align: left; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.pct { color: #5f5e5a; }
  tr.b td { font-weight: 700; }
  tr.section td { background: #DCE6F1; color: #1F497D; font-weight: 700; }
  tr.subtotal td { border-top: 1px solid #8FAADC; }
  tr.band td { background: #C6D9F1; color: #1F497D; border-top: 1.5px solid #1F497D; font-weight: 700; }
  tr.band.strong td { background: #B7CDEA; border-top: 2px solid #1F497D; border-bottom: 2px solid #1F497D; font-size: 12px; }
  tr.spacer td { height: 6px; border: none; }
  @media print { body { margin: 0; } thead { display: table-header-group; } tr { page-break-inside: avoid; } }
</style></head>
<body>
  <img class="rof-logo" src="${ROF_LOGO_DATA_URL}" alt="${escapeHtml(m.company)}" />
  <div class="company">${escapeHtml(m.company)}</div>
  <div class="title">${escapeHtml(m.reportTitle)}</div>
  <div class="period">${escapeHtml(m.periodLabel)}</div>
  <div class="meta">${escapeHtml(m.basisLabel)} · ${escapeHtml(m.printedLabel)}</div>
  <table><colgroup>${colGroup}</colgroup>
    <thead><tr>${headTh}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`;
}

export function printIncomeStatementPdf(m: StatementModel) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const html = buildIncomeStatementHtml(m);
  const win = window.open("", "_blank");
  if (!win) { void downloadIncomeStatementXlsx(m, `${m.reportTitle}`); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const triggerPrint = () => { try { win.focus(); win.print(); } catch { /* closed early */ } };
  if (win.document.readyState === "complete") setTimeout(triggerPrint, 150);
  else { win.onload = () => setTimeout(triggerPrint, 50); setTimeout(triggerPrint, 400); }
}
