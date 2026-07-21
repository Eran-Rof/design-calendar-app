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
import type { AoaCell, AoaImage } from "../shared/excelLogo";

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
  /** The single inseam shared by EVERY row of this style — rendered once in the
   *  style section header (e.g. "· Inseam 30") so a vendor reading the PO sees it.
   *  null when the style has no inseam or MIXES inseams (then each row label
   *  carries its own inseam instead). Mirrors the on-screen matrix. */
  inseam?: string | null;
  imageUrl?: string | null;   // item 25 — style thumbnail when "Show images" is on
};
// A non-matrix (flat) line — the rare one-off SKU / charge.
export type OrderDocFlat = {
  label: string;
  description?: string | null;
  qty: number;
  unitDollars: number;
};
// A prepack (PPK) breakdown for one style: the per-pack composition (inner pack
// + carton pack units per size) and the full explode (each color's packs ×
// carton-pack qty per size = garment units).
export type OrderDocPrepackSize = { size: string; inner: number; carton: number };
export type OrderDocPrepackColor = { color: string; packs: number };
export type OrderDocPrepack = {
  style: string;
  packToken: string;
  sizes: OrderDocPrepackSize[];
  colors: OrderDocPrepackColor[];
};
export type OrderDocData = { styles: OrderDocStyle[]; flats: OrderDocFlat[]; prepacks?: OrderDocPrepack[] };

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

// Row label = color, plus the inseam ONLY when it isn't already shown once in
// the style header (mixed-inseam styles). `showInseam` is false for a uniform
// style so the inseam isn't repeated on every row.
const rowLabel = (r: OrderDocMatrixRow, showInseam = true): string =>
  `${r.color || "—"}${showInseam && r.inseam ? ` · ${r.inseam}"` : ""}`;

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
        <td>${esc(rowLabel(r, !g.inseam))}</td>
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
      <div class="style-name">${g.imageUrl ? `<img class="style-img" src="${esc(g.imageUrl)}" alt="" />` : ""}${esc(g.style)}${g.description ? `<span class="sub"> — ${esc(g.description)}</span>` : ""}${g.inseam ? `<span class="sub"> · Inseam ${esc(g.inseam)}</span>` : ""}</div>
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

  // Prepack (PPK) detail — per PPK style, the pack composition (inner + carton
  // units per size) and the full explode (packs × carton qty per size).
  const prepackBlocks = (doc.data.prepacks || []).map((p) => {
    const sizes = p.sizes;
    const hasInner = sizes.some((s) => (s.inner || 0) > 0);
    const cartonTotal = sizes.reduce((a, s) => a + (s.carton || 0), 0);
    const innerTotal = sizes.reduce((a, s) => a + (s.inner || 0), 0);
    const headSizes = sizes.map((s) => `<th class="num">${esc(s.size)}</th>`).join("");
    const innerRow = hasInner ? `<tr><td>Inner pack</td>${sizes.map((s) => `<td class="num">${(s.inner || 0).toLocaleString()}</td>`).join("")}<td class="num">${innerTotal.toLocaleString()}</td></tr>` : "";
    const cartonRow = `<tr><td>Carton pack</td>${sizes.map((s) => `<td class="num">${(s.carton || 0).toLocaleString()}</td>`).join("")}<td class="num">${cartonTotal.toLocaleString()}</td></tr>`;
    const sizeTotals = sizes.map(() => 0);
    let gUnits = 0, gPacks = 0;
    const colorRows = p.colors.map((c) => {
      const tds = sizes.map((s, i) => { const u = c.packs * (s.carton || 0); sizeTotals[i] += u; return `<td class="num">${u.toLocaleString()}</td>`; }).join("");
      const rowUnits = c.packs * cartonTotal; gUnits += rowUnits; gPacks += c.packs;
      return `<tr><td>${esc(c.color)}</td>${tds}<td class="num">${rowUnits.toLocaleString()}</td><td class="num">${c.packs.toLocaleString()}</td></tr>`;
    }).join("");
    return `<div class="style-block">
      <div class="style-name">Prepack breakdown — ${esc(p.style)}${p.packToken ? `<span class="sub"> · ${esc(p.packToken)}</span>` : ""}</div>
      <div class="sub" style="font-size:11px;margin:2px 0">Pack composition (units per pack)</div>
      <table><thead><tr><th>Per pack</th>${headSizes}<th class="num">Pack</th></tr></thead>
        <tbody>${innerRow}${cartonRow}</tbody></table>
      <div class="sub" style="font-size:11px;margin:8px 0 2px">Full size breakdown (packs exploded to garment units)</div>
      <table><thead><tr><th>Color</th>${headSizes}<th class="num">Units</th><th class="num">Packs</th></tr></thead>
        <tbody>${colorRows}</tbody>
        <tfoot><tr><td>Total</td>${sizeTotals.map((t) => `<td class="num">${t.toLocaleString()}</td>`).join("")}<td class="num">${gUnits.toLocaleString()}</td><td class="num">${gPacks.toLocaleString()}</td></tr></tfoot></table>
    </div>`;
  }).join("");
  const prepackHtml = prepackBlocks ? `<div style="margin-top:18px"><div class="style-name" style="font-size:14px">Prepack (PPK) detail</div>${prepackBlocks}</div>` : "";

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
  .style-name { font-size: 13px; font-weight: 700; color: #1F497D; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .style-name .sub { color: #64748b; font-weight: 400; }
  .style-img { width: 46px; height: 46px; object-fit: cover; border: 1px solid #d0d8e4; border-radius: 4px; }
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
    ${prepackHtml}
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
// so the spreadsheet and the PDF never diverge. Built with the shared ExcelJS
// renderer (logo banner + real embedded style images, same wiring as the ATS
// export); ExcelJS + the image fetcher are dynamically imported so they only
// load when the operator actually exports.
export async function downloadOrderExcel(doc: OrderDocument): Promise<void> {
  if (typeof window === "undefined") return; // SSR / test safety
  // Embed real product images (item 25) when the order carries them — using the
  // SAME wiring as the ATS export: fetch the signed URLs into base64 (fetchDataUrls,
  // with studio-white trim) and anchor them onto the sheet via the shared ExcelJS
  // renderer (renderStyledAoa), which also stamps the Ring of Fire logo banner.
  // Both modules are dynamically imported so ExcelJS stays out of the main bundle.
  const [{ newWorkbook, renderStyledAoa, downloadExcelWorkbook }, { fetchDataUrls }] = await Promise.all([
    import("../shared/excelLogo"),
    import("../shared/exportImages"),
  ]);
  const imgUrls = doc.data.styles.map((g) => g.imageUrl).filter((u): u is string => !!u);
  const imgByUrl = imgUrls.length ? await fetchDataUrls(imgUrls, { trimWhitespace: true }) : new Map();

  const t = (v: string | number): AoaCell => ({ v });
  const aoa: AoaCell[][] = [];
  const images: AoaImage[] = [];
  const rowHeights: Array<number | undefined> = [];
  const push = (cells: AoaCell[], hpt?: number) => { rowHeights[aoa.length] = hpt; aoa.push(cells); };

  push([t(doc.title), t(doc.number)]);
  if (doc.status) push([t("Status"), t(doc.status)]);
  push([t(doc.partyLabel), t(doc.partyName || "—")]);
  for (const f of doc.fields) push([t(f.label), t(f.value)]);
  push([]);

  let grandQty = 0;
  let grandAmt = 0;
  for (const g of doc.data.styles) {
    const label = `${g.description ? `${g.style} — ${g.description}` : g.style}${g.inseam ? ` · Inseam ${g.inseam}` : ""}`;
    const im = g.imageUrl ? imgByUrl.get(g.imageUrl) : null;
    if (im && im.dataUrl) {
      // Image in col A (style name shifts to col B), row sized to the picture.
      const H = 96;
      const scale = im.h > 0 ? H / im.h : 1;
      const w = im.w > 0 ? Math.min(150, Math.round(im.w * scale)) : 72;
      images.push({ aoaRow: aoa.length, col: 0, dataUrl: im.dataUrl, width: w, height: H });
      push([t(""), t(label)], Math.round((H * 72) / 96) + 4); // px → pt + padding
    } else {
      push([t(label)]);
    }
    push([t("Color"), ...g.sizes.map(t), t("Qty"), t(doc.moneyLabel), t("Total $")]);
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
      push([t(rowLabel(r, !g.inseam)), ...g.sizes.map((sz) => t(r.qtyBySize[sz] || 0)), t(rowQty), t(unit), t(rowAmt)]);
    }
    push([t("Total"), ...g.sizes.map((sz) => t(colSums[sz] || 0)), t(styleQty), t(""), t(styleAmt)]);
    push([]);
    grandQty += styleQty;
    grandAmt += styleAmt;
  }

  if (doc.data.flats.length) {
    push([t("Other lines")]);
    push([t("Item"), t("Qty"), t(doc.moneyLabel), t("Total $")]);
    for (const f of doc.data.flats) {
      const qty = Number(f.qty) || 0;
      const unit = Number(f.unitDollars) || 0;
      const amt = qty * unit;
      grandQty += qty;
      grandAmt += amt;
      push([t(f.description ? `${f.label} — ${f.description}` : f.label), t(qty), t(unit), t(amt)]);
    }
    push([]);
  }

  // Prepack (PPK) detail — composition (inner + carton) + full explode per style.
  if (doc.data.prepacks && doc.data.prepacks.length) {
    push([t("Prepack (PPK) detail")]);
    for (const p of doc.data.prepacks) {
      const sizes = p.sizes;
      const hasInner = sizes.some((s) => (s.inner || 0) > 0);
      const cartonTotal = sizes.reduce((a, s) => a + (s.carton || 0), 0);
      push([t(`${p.style}${p.packToken ? ` · ${p.packToken}` : ""} — units per pack`)]);
      push([t("Per pack"), ...sizes.map((s) => t(s.size)), t("Pack")]);
      if (hasInner) push([t("Inner pack"), ...sizes.map((s) => t(s.inner || 0)), t(sizes.reduce((a, s) => a + (s.inner || 0), 0))]);
      push([t("Carton pack"), ...sizes.map((s) => t(s.carton || 0)), t(cartonTotal)]);
      push([t(`${p.style} — full size breakdown (packs exploded to units)`)]);
      push([t("Color"), ...sizes.map((s) => t(s.size)), t("Units"), t("Packs")]);
      const sizeTotals = sizes.map(() => 0);
      let gUnits = 0, gPacks = 0;
      for (const c of p.colors) {
        const cells = sizes.map((s, i) => { const u = c.packs * (s.carton || 0); sizeTotals[i] += u; return t(u); });
        gUnits += c.packs * cartonTotal; gPacks += c.packs;
        push([t(c.color), ...cells, t(c.packs * cartonTotal), t(c.packs)]);
      }
      push([t("Total"), ...sizeTotals.map(t), t(gUnits), t(gPacks)]);
      push([]);
    }
  }

  push([t("Grand total — Qty"), t(grandQty)]);
  push([t("Grand total — $"), t(grandAmt)]);
  if (doc.notes) { push([]); push([t("Notes"), t(doc.notes)]); }

  const colCount = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const cols = [24, ...Array(Math.max(0, colCount - 1)).fill(9)];
  const wb = newWorkbook();
  const safeSheet = doc.title.replace(/[\\/*?:[\]]/g, "-").slice(0, 31) || "Order";
  renderStyledAoa(wb, safeSheet, aoa, {
    banner: { cols: colCount },
    cols,
    rowHeights,
    images: images.length ? images : undefined,
  });
  const fname = `${doc.title.replace(/\s+/g, "_")}_${(doc.number || "draft").replace(/[^\w-]+/g, "")}.xlsx`;
  await downloadExcelWorkbook(wb, fname);
}
