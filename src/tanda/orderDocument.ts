// src/tanda/orderDocument.ts
//
// Printable / downloadable document view for a Sales Order or Purchase Order.
// Opens a new window with a clean, branded HTML document (logo + header fields +
// line-item table + totals) and a no-print toolbar offering "Print / Save as
// PDF" (the browser's print dialog handles both printing and PDF download).
//
// No external PDF dependency — same print-window approach as the table exports
// (src/tanda/exports/useTableExport.ts), so it works everywhere with no new dep.

import { ROF_LOGO_DATA_URL } from "../shared/assets/rofLogo";

export type OrderDocLine = {
  style: string;                 // style code, or the SKU/label for a non-matrix line
  description?: string | null;
  color?: string | null;
  inseam?: string | null;
  size?: string | null;
  qty: number;
  unitDollars: number;
};

export type OrderDocument = {
  kind: "so" | "po";
  title: string;                 // e.g. "Sales Order" / "Purchase Order"
  number: string;                // e.g. "PO-2026-00012" or "(draft)"
  status?: string | null;
  partyLabel: string;            // "Customer" | "Vendor"
  partyName: string;
  moneyLabel: string;            // "Unit $" | "Unit Cost $"
  fields: { label: string; value: string }[];   // header key/value pairs (skip blanks before calling)
  lines: OrderDocLine[];
  notes?: string | null;
};

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const money = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function openOrderDocument(doc: OrderDocument): void {
  if (typeof window === "undefined" || typeof document === "undefined") return; // SSR / test safety

  const totalQty = doc.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalAmt = doc.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitDollars) || 0), 0);

  const fieldsHtml = doc.fields
    .map((f) => `<div class="f"><span class="fl">${esc(f.label)}</span><span class="fv">${esc(f.value)}</span></div>`)
    .join("");

  const lineRows = doc.lines.length
    ? doc.lines
        .map((l) => {
          const lineTotal = (Number(l.qty) || 0) * (Number(l.unitDollars) || 0);
          return `<tr>
            <td>${esc(l.style || "")}${l.description ? `<span class="sub"> — ${esc(l.description)}</span>` : ""}</td>
            <td>${esc(l.color || "—")}</td>
            <td>${esc(l.inseam || "—")}</td>
            <td>${esc(l.size || "—")}</td>
            <td class="num">${(Number(l.qty) || 0).toLocaleString()}</td>
            <td class="num">$${money(Number(l.unitDollars) || 0)}</td>
            <td class="num">$${money(lineTotal)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">No line items.</td></tr>`;

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
  .page { max-width: 920px; margin: 16px auto 40px; background: #fff; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
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
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d0d8e4; padding: 5px 9px; text-align: left; vertical-align: top; }
  thead th { background: #1F497D; color: #fff; font-weight: 600; }
  tbody tr:nth-child(even) { background: #eef3fa; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty { text-align: center; color: #94a3b8; font-style: italic; }
  .sub { color: #64748b; }
  tfoot td { font-weight: 700; background: #f8fafc; }
  .notes { margin-top: 16px; font-size: 12px; }
  .notes .fl { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #94a3b8; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .page { box-shadow: none; margin: 0; max-width: none; padding: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
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
    <table>
      <thead><tr>
        <th>Style</th><th>Color</th><th>Inseam</th><th>Size</th>
        <th class="num">Qty</th><th class="num">${esc(doc.moneyLabel)}</th><th class="num">Total $</th>
      </tr></thead>
      <tbody>${lineRows}</tbody>
      <tfoot><tr>
        <td colspan="4">Total</td>
        <td class="num">${totalQty.toLocaleString()}</td>
        <td class="num"></td>
        <td class="num">$${money(totalAmt)}</td>
      </tr></tfoot>
    </table>
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
}
