// src/tanda/orderDocument.ts
//
// Printable / downloadable document view for a Sales Order or Purchase Order.
// Opens a new window with a clean, branded HTML document (logo + header fields +
// a per-style color × size MATRIX + totals) and a no-print toolbar offering
// "Print / Save as PDF" (the browser's print dialog handles both printing and
// PDF download).
//
// No external PDF dependency — same print-window approach as the table exports
// (src/tanda/exports/useTableExport.ts), so it works everywhere with no new dep.

import { ROF_LOGO_DATA_URL } from "../shared/assets/rofLogo";

// One color (× inseam) row of a style's matrix: a qty per size.
export type OrderDocMatrixRow = {
  color: string | null;
  inseam: string | null;
  unitDollars: number;
  qtyBySize: Record<string, number>;
};
// A style block — its size columns (in scale order) and its color rows.
export type OrderDocStyle = {
  style: string;
  description?: string | null;
  sizes: string[];
  rows: OrderDocMatrixRow[];
};
// A non-matrix (flat) line — the rare one-off SKU / charge.
export type OrderDocFlat = {
  label: string;
  description?: string | null;
  qty: number;
  unitDollars: number;
};
export type OrderDocData = { styles: OrderDocStyle[]; flats: OrderDocFlat[] };

export type OrderDocument = {
  kind: "so" | "po";
  title: string;                 // e.g. "Sales Order" / "Purchase Order"
  number: string;                // e.g. "PO-2026-00012" or "(draft)"
  status?: string | null;
  partyLabel: string;            // "Customer" | "Vendor"
  partyName: string;
  moneyLabel: string;            // "Unit $" | "Unit Cost $"
  fields: { label: string; value: string }[];   // header key/value pairs (skip blanks before calling)
  data: OrderDocData;
  notes?: string | null;
  autoPrint?: boolean;           // open straight into the browser print / save-as-PDF dialog
};

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const money = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const rowLabel = (r: OrderDocMatrixRow): string =>
  `${r.color || "—"}${r.inseam ? ` · ${r.inseam}"` : ""}`;

export function openOrderDocument(doc: OrderDocument): void {
  if (typeof window === "undefined" || typeof document === "undefined") return; // SSR / test safety

  let grandQty = 0;
  let grandAmt = 0;

  // One matrix table per style: color (× inseam) rows × size columns.
  const styleBlocks = doc.data.styles.map((g) => {
    const sizes = g.sizes;
    const colSums: Record<string, number> = {};
    let styleQty = 0;
    let styleAmt = 0;

    const bodyRows = g.rows.map((r) => {
      const rowQty = sizes.reduce((s, sz) => s + (r.qtyBySize[sz] || 0), 0);
      const rowAmt = rowQty * (Number(r.unitDollars) || 0);
      styleQty += rowQty;
      styleAmt += rowAmt;
      const cells = sizes
        .map((sz) => {
          const v = r.qtyBySize[sz] || 0;
          colSums[sz] = (colSums[sz] || 0) + v;
          return `<td class="num">${v ? v.toLocaleString() : ""}</td>`;
        })
        .join("");
      return `<tr>
        <td>${esc(rowLabel(r))}</td>
        ${cells}
        <td class="num">${rowQty.toLocaleString()}</td>
        <td class="num">$${money(Number(r.unitDollars) || 0)}</td>
        <td class="num">$${money(rowAmt)}</td>
      </tr>`;
    }).join("");

    grandQty += styleQty;
    grandAmt += styleAmt;

    const headSizes = sizes.map((sz) => `<th class="num">${esc(sz)}</th>`).join("");
    const footSizes = sizes.map((sz) => `<td class="num">${colSums[sz] ? colSums[sz].toLocaleString() : ""}</td>`).join("");

    return `<div class="style-block">
      <div class="style-name">${esc(g.style)}${g.description ? `<span class="sub"> — ${esc(g.description)}</span>` : ""}</div>
      <table>
        <thead><tr>
          <th>Color</th>${headSizes}
          <th class="num">Qty</th><th class="num">${esc(doc.moneyLabel)}</th><th class="num">Total $</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr>
          <td>Total</td>${footSizes}
          <td class="num">${styleQty.toLocaleString()}</td><td class="num"></td><td class="num">$${money(styleAmt)}</td>
        </tr></tfoot>
      </table>
    </div>`;
  }).join("");

  // Non-matrix lines (rare) — a simple table.
  let flatsBlock = "";
  if (doc.data.flats.length) {
    const flatRows = doc.data.flats.map((f) => {
      const amt = (Number(f.qty) || 0) * (Number(f.unitDollars) || 0);
      grandQty += Number(f.qty) || 0;
      grandAmt += amt;
      return `<tr>
        <td>${esc(f.label)}${f.description ? `<span class="sub"> — ${esc(f.description)}</span>` : ""}</td>
        <td class="num">${(Number(f.qty) || 0).toLocaleString()}</td>
        <td class="num">$${money(Number(f.unitDollars) || 0)}</td>
        <td class="num">$${money(amt)}</td>
      </tr>`;
    }).join("");
    flatsBlock = `<div class="style-block">
      <div class="style-name">Other lines</div>
      <table>
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">${esc(doc.moneyLabel)}</th><th class="num">Total $</th></tr></thead>
        <tbody>${flatRows}</tbody>
      </table>
    </div>`;
  }

  const fieldsHtml = doc.fields
    .map((f) => `<div class="f"><span class="fl">${esc(f.label)}</span><span class="fv">${esc(f.value)}</span></div>`)
    .join("");

  const linesHtml = (styleBlocks + flatsBlock) || `<div class="empty">No line items.</div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(doc.title)} ${esc(doc.number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; color: #0f172a; background: #f1f5f9; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 8px; justify-content: flex-end; padding: 10px 16px; background: #1e293b; }
  .toolbar button { font-size: 13px; font-weight: 600; border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
  .btn-print { background: #3b82f6; color: #fff; }
  .btn-close { background: transparent; color: #cbd5e1; border: 1px solid #475569; }
  .page { max-width: 1040px; margin: 16px auto 40px; background: #fff; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .rof-logo { height: 34px; display: block; margin-bottom: 14px; }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1F497D; padding-bottom: 10px; margin-bottom: 14px; }
  .doc-title { font-size: 22px; font-weight: 700; color: #1F497D; margin: 0; }
  .doc-number { font-size: 15px; color: #0f172a; margin-top: 2px; }
  .doc-status { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
  .party { text-align: right; }
  .party .pl { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
  .party .pn { font-size: 16px; font-weight: 700; }
  .fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 22px; margin-bottom: 18px; }
  .f { font-size: 12px; display: flex; flex-direction: column; }
  .fl { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #94a3b8; }
  .fv { color: #0f172a; }
  .style-block { margin-bottom: 18px; }
  .style-name { font-size: 13px; font-weight: 700; color: #1F497D; margin-bottom: 4px; }
  .style-name .sub { color: #64748b; font-weight: 400; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d0d8e4; padding: 5px 9px; text-align: left; vertical-align: top; white-space: nowrap; }
  thead th { background: #1F497D; color: #fff; font-weight: 600; }
  tbody tr:nth-child(even) { background: #eef3fa; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; background: #f8fafc; }
  .sub { color: #64748b; }
  .empty { color: #94a3b8; font-style: italic; }
  .grand { margin-top: 14px; padding-top: 10px; border-top: 2px solid #1F497D; display: flex; gap: 32px; justify-content: flex-end; font-size: 13px; }
  .grand b { font-variant-numeric: tabular-nums; }
  .notes { margin-top: 16px; font-size: 12px; }
  .notes .fl { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #94a3b8; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .page { box-shadow: none; margin: 0; max-width: none; padding: 0; }
    thead { display: table-header-group; }
    tr, .style-block { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">🖨 Print / Save as PDF</button>
    <button class="btn-close" onclick="window.close()">Close</button>
  </div>
  <div class="page">
    <img class="rof-logo" src="${ROF_LOGO_DATA_URL}" alt="Ring of Fire" />
    <div class="doc-head">
      <div>
        <h1 class="doc-title">${esc(doc.title)}</h1>
        <div class="doc-number">${esc(doc.number)}</div>
        ${doc.status ? `<div class="doc-status">${esc(doc.status)}</div>` : ""}
      </div>
      <div class="party">
        <div class="pl">${esc(doc.partyLabel)}</div>
        <div class="pn">${esc(doc.partyName || "—")}</div>
      </div>
    </div>
    <div class="fields">${fieldsHtml}</div>
    ${linesHtml}
    <div class="grand">
      <span>Total qty <b>${grandQty.toLocaleString()}</b></span>
      <span>Total $ <b>$${money(grandAmt)}</b></span>
    </div>
    ${doc.notes ? `<div class="notes"><span class="fl">Notes</span><div>${esc(doc.notes)}</div></div>` : ""}
  </div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    // Pop-up blocked.
    // eslint-disable-next-line no-alert
    window.alert("Please allow pop-ups for this site to view the printable document.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // "Save as PDF" path — jump straight into the print dialog. The logo is an
  // embedded data URL so layout is ready almost immediately; a short delay
  // lets the document paint before the (modal) print dialog freezes it.
  if (doc.autoPrint) { try { win.setTimeout(() => win.print(), 400); } catch { /* ignore */ } }
}

// Download the SAME order document as an .xlsx — header block, then one
// stacked matrix table per style (Color × sizes × Qty/Unit/Total), the flat
// lines, and grand totals. Reuses the OrderDocData the printable view builds,
// so the spreadsheet and the PDF never diverge. xlsx is dynamically imported
// so it only loads when the operator actually exports.
export async function downloadOrderExcel(doc: OrderDocument): Promise<void> {
  if (typeof window === "undefined") return; // SSR / test safety
  const XLSX = await import("xlsx");
  const aoa: (string | number)[][] = [];
  aoa.push([doc.title, doc.number]);
  if (doc.status) aoa.push(["Status", doc.status]);
  aoa.push([doc.partyLabel, doc.partyName || "—"]);
  for (const f of doc.fields) aoa.push([f.label, f.value]);
  aoa.push([]);

  let grandQty = 0;
  let grandAmt = 0;
  for (const g of doc.data.styles) {
    aoa.push([g.description ? `${g.style} — ${g.description}` : g.style]);
    aoa.push(["Color", ...g.sizes, "Qty", doc.moneyLabel, "Total $"]);
    const colSums: Record<string, number> = {};
    let styleQty = 0;
    let styleAmt = 0;
    for (const r of g.rows) {
      const rowQty = g.sizes.reduce((s, sz) => s + (r.qtyBySize[sz] || 0), 0);
      const unit = Number(r.unitDollars) || 0;
      const rowAmt = rowQty * unit;
      styleQty += rowQty;
      styleAmt += rowAmt;
      g.sizes.forEach((sz) => { colSums[sz] = (colSums[sz] || 0) + (r.qtyBySize[sz] || 0); });
      aoa.push([rowLabel(r), ...g.sizes.map((sz) => r.qtyBySize[sz] || 0), rowQty, unit, rowAmt]);
    }
    aoa.push(["Total", ...g.sizes.map((sz) => colSums[sz] || 0), styleQty, "", styleAmt]);
    aoa.push([]);
    grandQty += styleQty;
    grandAmt += styleAmt;
  }

  if (doc.data.flats.length) {
    aoa.push(["Other lines"]);
    aoa.push(["Item", "Qty", doc.moneyLabel, "Total $"]);
    for (const f of doc.data.flats) {
      const qty = Number(f.qty) || 0;
      const unit = Number(f.unitDollars) || 0;
      const amt = qty * unit;
      grandQty += qty;
      grandAmt += amt;
      aoa.push([f.description ? `${f.label} — ${f.description}` : f.label, qty, unit, amt]);
    }
    aoa.push([]);
  }

  aoa.push(["Grand total — Qty", grandQty]);
  aoa.push(["Grand total — $", grandAmt]);
  if (doc.notes) { aoa.push([]); aoa.push(["Notes", doc.notes]); }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 24 }, ...Array(16).fill({ wch: 9 })];
  const wb = XLSX.utils.book_new();
  const safeSheet = doc.title.replace(/[\\/*?:[\]]/g, "-").slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, safeSheet || "Order");
  const fname = `${doc.title.replace(/\s+/g, "_")}_${(doc.number || "draft").replace(/[^\w-]+/g, "")}.xlsx`;
  XLSX.writeFile(wb, fname);
}
