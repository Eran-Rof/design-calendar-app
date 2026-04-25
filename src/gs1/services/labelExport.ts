// ── Label export service ───────────────────────────────────────────────────────
// Generates printable HTML (window.print) and CSV for label batches.
// Phase 1: no barcode rendering library; GTIN displayed in large monospace text.
// Phase 2 stub: add barcode lib (e.g. bwip-js) and replace text with SVG.

import type { LabelBatchLine, Carton } from "../types";
import { formatGtin14Display, formatSscc18Display } from "./gtinService";

// ── CSV export ────────────────────────────────────────────────────────────────
// Suitable for BarTender, Zebra Designer, and similar label software.

export function exportLabelsCsv(batchName: string, lines: LabelBatchLine[]): void {
  const header = ["Pack GTIN", "Style No", "Color", "Scale Code", "Label Qty", "Channel", "Sheet"];
  const csvRows = [
    header.join(","),
    ...lines.map(l =>
      [l.pack_gtin, l.style_no, l.color, l.scale_code, l.label_qty, l.source_channel ?? "", l.source_sheet_name ?? ""]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    ),
  ];
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${batchName.replace(/[^a-z0-9]/gi, "_")}_labels.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Print-ready HTML ──────────────────────────────────────────────────────────
// Opens a new window with label-per-page layout and triggers window.print().
// Each label occupies one "page" (4x6 inch by default, common for Zebra printers).

export function printLabelBatch(batchName: string, lines: LabelBatchLine[]): void {
  // Expand lines: repeat each line label_qty times
  const expanded: Array<{ line: LabelBatchLine; copyNum: number; totalCopies: number }> = [];
  for (const line of lines) {
    for (let i = 1; i <= line.label_qty; i++) {
      expanded.push({ line, copyNum: i, totalCopies: line.label_qty });
    }
  }

  const labelHtml = expanded
    .map(({ line, copyNum, totalCopies }) => `
      <div class="label">
        <div class="label-header">GS1 Prepack Label</div>
        <div class="gtin-barcode">${line.pack_gtin}</div>
        <div class="gtin-human">${formatGtin14Display(line.pack_gtin)}</div>
        <div class="label-fields">
          <div class="label-row"><span class="lbl">Style</span><span class="val">${line.style_no}</span></div>
          <div class="label-row"><span class="lbl">Color</span><span class="val">${line.color}</span></div>
          <div class="label-row"><span class="lbl">Scale</span><span class="val">${line.scale_code}</span></div>
          ${line.source_channel ? `<div class="label-row"><span class="lbl">Channel</span><span class="val">${line.source_channel}</span></div>` : ""}
        </div>
        <div class="label-footer">${copyNum} of ${totalCopies}</div>
      </div>
    `)
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${batchName} — Labels</title>
  <style>
    @page { size: 4in 6in; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fff; }
    .label {
      width: 4in; height: 6in;
      padding: 0.25in;
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      border: 1px solid #ccc;
      page-break-after: always;
    }
    .label:last-child { page-break-after: auto; }
    .label-header {
      font-size: 10pt; color: #666; text-transform: uppercase;
      letter-spacing: 0.1em; margin-bottom: 12px;
    }
    .gtin-barcode {
      font-family: 'Courier New', Courier, monospace;
      font-size: 32pt; font-weight: bold;
      letter-spacing: 0.05em; text-align: center;
      margin: 12px 0 4px;
      border: 2px solid #000; padding: 8px 16px; border-radius: 4px;
    }
    .gtin-human {
      font-size: 11pt; color: #333; letter-spacing: 0.08em;
      margin-bottom: 20px; font-family: 'Courier New', Courier, monospace;
    }
    .label-fields { width: 100%; border-top: 1px solid #eee; padding-top: 12px; }
    .label-row {
      display: flex; justify-content: space-between;
      padding: 4px 0; border-bottom: 1px solid #f0f0f0; font-size: 12pt;
    }
    .lbl { font-weight: 600; color: #444; }
    .val { color: #000; }
    .label-footer { margin-top: 12px; font-size: 9pt; color: #999; }
  </style>
</head>
<body>
  ${labelHtml}
  <script>
    window.onload = function() {
      window.print();
      setTimeout(function() { window.close(); }, 1000);
    };
  <\/script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Please allow pop-ups to print labels.");
    return;
  }
  win.document.write(html);
  win.document.close();
}

// ── SSCC CSV export ───────────────────────────────────────────────────────────
// One row per physical carton. Suitable for BarTender, WMS, or 3PL EDI uploads.

export function exportSsccCsv(batchName: string, cartons: Carton[]): void {
  const header = ["SSCC", "SSCC Display", "Serial Reference", "Pack GTIN", "Style No", "Color", "Scale Code", "Carton Seq", "Status"];
  const rows = [
    header.join(","),
    ...cartons.map(c =>
      [
        c.sscc,
        formatSscc18Display(c.sscc),
        c.serial_reference,
        c.pack_gtin ?? "",
        c.style_no ?? "",
        c.color ?? "",
        c.scale_code ?? "",
        c.carton_seq,
        c.status,
      ]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    ),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${batchName.replace(/[^a-z0-9]/gi, "_")}_sscc_cartons.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── SSCC print labels ─────────────────────────────────────────────────────────
// Opens a 4×6 print window — one label per carton, shows SSCC-18 barcode text.

export function printSsccLabels(batchName: string, cartons: Carton[]): void {
  const labelHtml = cartons
    .map(c => `
      <div class="label">
        <div class="label-header">GS1 Shipping Carton Label</div>
        <div class="ai-label">(00)</div>
        <div class="sscc-barcode">${c.sscc}</div>
        <div class="sscc-human">${formatSscc18Display(c.sscc)}</div>
        <div class="label-fields">
          ${c.style_no  ? `<div class="label-row"><span class="lbl">Style</span><span class="val">${c.style_no}</span></div>` : ""}
          ${c.color     ? `<div class="label-row"><span class="lbl">Color</span><span class="val">${c.color}</span></div>` : ""}
          ${c.scale_code ? `<div class="label-row"><span class="lbl">Scale</span><span class="val">${c.scale_code}</span></div>` : ""}
          ${c.pack_gtin ? `<div class="label-row"><span class="lbl">Pack GTIN</span><span class="val" style="font-family:monospace">${c.pack_gtin}</span></div>` : ""}
        </div>
        <div class="label-footer">Carton ${c.carton_seq}</div>
      </div>
    `)
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${batchName} — SSCC Carton Labels</title>
  <style>
    @page { size: 4in 6in; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fff; }
    .label {
      width: 4in; height: 6in;
      padding: 0.25in;
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      border: 1px solid #ccc;
      page-break-after: always;
    }
    .label:last-child { page-break-after: auto; }
    .label-header { font-size: 9pt; color: #666; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .ai-label { font-size: 14pt; font-weight: bold; letter-spacing: 0.05em; margin-bottom: 0; }
    .sscc-barcode {
      font-family: 'Courier New', Courier, monospace;
      font-size: 22pt; font-weight: bold;
      letter-spacing: 0.05em; text-align: center;
      margin: 8px 0 2px;
      border: 2px solid #000; padding: 6px 12px; border-radius: 4px;
    }
    .sscc-human { font-size: 10pt; color: #333; letter-spacing: 0.06em; margin-bottom: 16px; font-family: 'Courier New', Courier, monospace; }
    .label-fields { width: 100%; border-top: 1px solid #eee; padding-top: 10px; }
    .label-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f0f0f0; font-size: 11pt; }
    .lbl { font-weight: 600; color: #444; }
    .val { color: #000; }
    .label-footer { margin-top: 10px; font-size: 9pt; color: #999; }
  </style>
</head>
<body>
  ${labelHtml}
  <script>
    window.onload = function() {
      window.print();
      setTimeout(function() { window.close(); }, 1000);
    };
  <\/script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Please allow pop-ups to print SSCC labels.");
    return;
  }
  win.document.write(html);
  win.document.close();
}

// ── Label preview HTML (inline, no new window) ────────────────────────────────
// Used by the LabelBatchPanel to show a rendered preview.

export function buildLabelPreviewHtml(line: LabelBatchLine): string {
  return `
    <div style="border:2px solid #2D3748;border-radius:8px;padding:16px;max-width:300px;font-family:system-ui;text-align:center;">
      <div style="font-size:10px;color:#718096;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">GS1 Prepack Label</div>
      <div style="font-family:'Courier New',monospace;font-size:18px;font-weight:bold;border:2px solid #000;padding:6px 12px;border-radius:4px;margin-bottom:4px;">${line.pack_gtin}</div>
      <div style="font-size:11px;font-family:'Courier New',monospace;color:#444;margin-bottom:12px;">${formatGtin14Display(line.pack_gtin)}</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <tr><td style="text-align:left;font-weight:600;padding:2px 0;color:#555;">Style</td><td style="text-align:right;">${line.style_no}</td></tr>
        <tr><td style="text-align:left;font-weight:600;padding:2px 0;color:#555;">Color</td><td style="text-align:right;">${line.color}</td></tr>
        <tr><td style="text-align:left;font-weight:600;padding:2px 0;color:#555;">Scale</td><td style="text-align:right;">${line.scale_code}</td></tr>
        <tr><td style="text-align:left;font-weight:600;padding:2px 0;color:#555;">Qty to print</td><td style="text-align:right;font-weight:bold;color:#C8210A;">${line.label_qty}</td></tr>
      </table>
    </div>`;
}
