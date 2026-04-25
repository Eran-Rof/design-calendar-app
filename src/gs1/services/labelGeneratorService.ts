// ── Label Generator Service ────────────────────────────────────────────────────
// Pure functions for label validation, ZPL generation, CSV generation, and
// print-ready HTML construction. Browser download/print helpers are at the
// bottom and are excluded from unit tests (they touch the DOM).

import { formatGtin14Display, formatSscc18Display } from "./gtinService";
import type { LabelTemplate, LabelBatchLine, Carton, HumanReadableFields } from "../types";

// ── Validation ────────────────────────────────────────────────────────────────

export function validateGtinLabel(gtin: string, qty: number): string[] {
  const errors: string[] = [];
  if (!/^\d{14}$/.test(gtin))
    errors.push(`GTIN must be exactly 14 digits — got "${gtin}" (${gtin.length} chars)`);
  if (qty <= 0)
    errors.push(`Label quantity must be > 0 — got ${qty}`);
  return errors;
}

export function validateSsccLabel(sscc: string): string[] {
  const errors: string[] = [];
  if (!/^\d{18}$/.test(sscc))
    errors.push(`SSCC must be exactly 18 digits — got "${sscc}" (${sscc.length} chars)`);
  return errors;
}

export function validateBatchForPrint(lines: LabelBatchLine[]): string[] {
  const errors: string[] = [];
  for (const l of lines) {
    const errs = validateGtinLabel(l.pack_gtin, l.label_qty);
    for (const e of errs) errors.push(`Line ${l.style_no}/${l.color}: ${e}`);
  }
  return errors;
}

export function validateCartonsForPrint(cartons: Carton[]): string[] {
  const errors: string[] = [];
  for (const c of cartons) {
    const errs = validateSsccLabel(c.sscc);
    for (const e of errs) errors.push(`Carton ${c.carton_seq}: ${e}`);
  }
  return errors;
}

// ── Template helpers ──────────────────────────────────────────────────────────

const DEFAULT_GTIN_FIELDS: HumanReadableFields = {
  show_style: true, show_color: true, show_scale: true, show_channel: true,
  show_po: false,   show_carton: false, show_units: false,
};
const DEFAULT_SSCC_FIELDS: HumanReadableFields = {
  show_style: true, show_color: true, show_scale: false, show_channel: false,
  show_po: true,    show_carton: true, show_units: true,
};

function fields(template: LabelTemplate): HumanReadableFields {
  return (template.human_readable_fields as HumanReadableFields | null) ??
    (template.label_type === "sscc" ? DEFAULT_SSCC_FIELDS : DEFAULT_GTIN_FIELDS);
}

function labelDims(template: LabelTemplate): { w: string; h: string } {
  return {
    w: template.label_width  ? `${template.label_width}in`  : "4in",
    h: template.label_height ? `${template.label_height}in` : "6in",
  };
}

function dotsDim(inches: string | null, dpi = 203): number {
  if (!inches) return 0;
  const n = parseFloat(inches);
  return isNaN(n) ? 0 : Math.round(n * dpi);
}

// ── ZPL generation ────────────────────────────────────────────────────────────
// ZPL II command reference:
//   ^XA/^XZ — label start/end
//   ^PW      — print width (dots)
//   ^LL      — label length (dots)
//   ^FO      — field origin (x, y)
//   ^A0N     — scalable font, normal orientation
//   ^BY3     — barcode module width
//   ^BCN     — Code 128 barcode (auto mode), no truncation, human-readable below
//   ^FD...^FS — field data
//   >;       — ZPL FNC1 prefix for GS1-128 application identifiers

export function generateGtinZpl(line: LabelBatchLine, template: LabelTemplate): string {
  const f = fields(template);
  const pw = dotsDim(template.label_width)  || 812;   // 4" @ 203dpi
  const ll = dotsDim(template.label_height) || 1218;  // 6" @ 203dpi

  const barcodeData = template.barcode_format !== "code128"
    ? `>;01${line.pack_gtin}`   // GS1-128 AI (01) for GTIN-14
    : line.pack_gtin;

  const cmds: string[] = [
    `^XA`,
    `^PW${pw}`,
    `^LL${ll}`,
    `^FO30,30^A0N,22,22^FDGS1 Prepack Label^FS`,
    `^FO30,60^BY3^BCN,100,Y,N,N^FD${barcodeData}^FS`,
    `^FO30,185^A0N,30,30^FD${formatGtin14Display(line.pack_gtin)}^FS`,
  ];

  let y = 230;
  const dy = 38;
  if (f.show_style)   { cmds.push(`^FO30,${y}^A0N,26,26^FDStyle: ${line.style_no}^FS`);           y += dy; }
  if (f.show_color)   { cmds.push(`^FO30,${y}^A0N,26,26^FDColor: ${line.color}^FS`);              y += dy; }
  if (f.show_scale)   { cmds.push(`^FO30,${y}^A0N,26,26^FDScale: ${line.scale_code}^FS`);         y += dy; }
  if (f.show_channel && line.source_channel) {
    cmds.push(`^FO30,${y}^A0N,26,26^FDChannel: ${line.source_channel}^FS`); y += dy;
  }
  cmds.push(`^XZ`);
  return cmds.join("\n");
}

export function generateSsccZpl(carton: Carton, template: LabelTemplate): string {
  const f = fields(template);
  const pw = dotsDim(template.label_width)  || 812;
  const ll = dotsDim(template.label_height) || 1218;

  const barcodeData = template.barcode_format !== "code128"
    ? `>;00${carton.sscc}`      // GS1-128 AI (00) for SSCC-18
    : carton.sscc;

  const cmds: string[] = [
    `^XA`,
    `^PW${pw}`,
    `^LL${ll}`,
    `^FO30,30^A0N,22,22^FDGS1 Shipping Carton Label^FS`,
    `^FO30,60^BY3^BCN,100,Y,N,N^FD${barcodeData}^FS`,
    `^FO30,185^A0N,26,26^FD(00) ${formatSscc18Display(carton.sscc)}^FS`,
  ];

  let y = 230;
  const dy = 38;
  if (f.show_style  && carton.style_no) { cmds.push(`^FO30,${y}^A0N,26,26^FDStyle: ${carton.style_no}^FS`);   y += dy; }
  if (f.show_color  && carton.color)    { cmds.push(`^FO30,${y}^A0N,26,26^FDColor: ${carton.color}^FS`);      y += dy; }
  if (f.show_po     && carton.po_number){ cmds.push(`^FO30,${y}^A0N,26,26^FDPO: ${carton.po_number}^FS`);     y += dy; }
  if (f.show_carton) { cmds.push(`^FO30,${y}^A0N,26,26^FDCarton: ${carton.carton_seq}^FS`);                  y += dy; }
  if (f.show_units  && carton.total_units != null) {
    cmds.push(`^FO30,${y}^A0N,26,26^FDUnits: ${carton.total_units}^FS`); y += dy;
  }
  cmds.push(`^XZ`);
  return cmds.join("\n");
}

export function generateBatchZpl(lines: LabelBatchLine[], template: LabelTemplate): string {
  const blocks: string[] = [];
  for (const line of lines) {
    const labelZpl = generateGtinZpl(line, template);
    for (let i = 0; i < line.label_qty; i++) blocks.push(labelZpl);
  }
  return blocks.join("\n");
}

export function generateSsccBatchZpl(cartons: Carton[], template: LabelTemplate): string {
  return cartons.map(c => generateSsccZpl(c, template)).join("\n");
}

// ── CSV generation ────────────────────────────────────────────────────────────

export function generateGtinCsvData(lines: LabelBatchLine[]): string {
  const header = ["Pack GTIN", "GTIN Display", "Style No", "Color", "Scale Code",
                  "Label Qty", "Channel", "Sheet"];
  const rows = [
    header.join(","),
    ...lines.map(l =>
      [
        l.pack_gtin,
        formatGtin14Display(l.pack_gtin),
        l.style_no,
        l.color,
        l.scale_code,
        l.label_qty,
        l.source_channel  ?? "",
        l.source_sheet_name ?? "",
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
    ),
  ];
  return rows.join("\n");
}

export function generateSsccCsvData(cartons: Carton[]): string {
  const header = ["SSCC", "SSCC Display", "Serial Reference", "Pack GTIN",
                  "Style No", "Color", "Scale Code", "Carton Seq",
                  "PO Number", "Channel", "Total Packs", "Total Units", "Status"];
  const rows = [
    header.join(","),
    ...cartons.map(c =>
      [
        c.sscc,
        formatSscc18Display(c.sscc),
        c.serial_reference,
        c.pack_gtin    ?? "",
        c.style_no     ?? "",
        c.color        ?? "",
        c.scale_code   ?? "",
        c.carton_seq,
        c.po_number    ?? "",
        c.channel      ?? "",
        c.total_packs  ?? "",
        c.total_units  ?? "",
        c.status,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
    ),
  ];
  return rows.join("\n");
}

// ── Print-ready HTML ──────────────────────────────────────────────────────────

function labelPageCss(w: string, h: string): string {
  return `
    @page { size: ${w} ${h}; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fff; }
    .label {
      width: ${w}; height: ${h};
      padding: 0.22in;
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      border: 1px solid #ccc; page-break-after: always;
    }
    .label:last-child { page-break-after: auto; }
    .label-header { font-size: 9pt; color: #666; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 10px; }
    .barcode-box {
      font-family: 'Courier New', Courier, monospace;
      font-size: 26pt; font-weight: bold; letter-spacing: .04em;
      border: 2px solid #000; padding: 6px 14px; border-radius: 4px;
      margin: 10px 0 4px; text-align: center;
    }
    .barcode-human { font-size: 10pt; font-family: 'Courier New', Courier, monospace; color: #333; letter-spacing: .08em; margin-bottom: 16px; }
    .ai-prefix { font-size: 13pt; font-weight: bold; margin-bottom: 2px; }
    .label-fields { width: 100%; border-top: 1px solid #eee; padding-top: 10px; }
    .label-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f0f0f0; font-size: 11pt; }
    .lbl { font-weight: 600; color: #444; }
    .val { color: #000; }
    .label-footer { margin-top: 10px; font-size: 9pt; color: #999; }
  `;
}

export function buildGtinPrintHtml(batchName: string, lines: LabelBatchLine[], template: LabelTemplate): string {
  const f = fields(template);
  const { w, h } = labelDims(template);

  const expanded: Array<{ line: LabelBatchLine; copy: number; total: number }> = [];
  for (const line of lines) {
    for (let i = 1; i <= line.label_qty; i++) expanded.push({ line, copy: i, total: line.label_qty });
  }

  const labelsHtml = expanded.map(({ line, copy, total }) => {
    const extraRows = [
      f.show_style   ? `<div class="label-row"><span class="lbl">Style</span><span class="val">${line.style_no}</span></div>` : "",
      f.show_color   ? `<div class="label-row"><span class="lbl">Color</span><span class="val">${line.color}</span></div>` : "",
      f.show_scale   ? `<div class="label-row"><span class="lbl">Scale</span><span class="val">${line.scale_code}</span></div>` : "",
      f.show_channel && line.source_channel
        ? `<div class="label-row"><span class="lbl">Channel</span><span class="val">${line.source_channel}</span></div>` : "",
    ].join("");
    return `
      <div class="label">
        <div class="label-header">GS1 Prepack Label</div>
        <div class="barcode-box">${line.pack_gtin}</div>
        <div class="barcode-human">${formatGtin14Display(line.pack_gtin)}</div>
        <div class="label-fields">${extraRows}</div>
        <div class="label-footer">${copy} of ${total}</div>
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(batchName)} — GTIN Labels</title>
<style>${labelPageCss(w, h)}</style>
</head><body>
${labelsHtml}
<script>window.onload=function(){window.print();setTimeout(function(){window.close();},1200);};<\/script>
</body></html>`;
}

export function buildSsccPrintHtml(batchName: string, cartons: Carton[], template: LabelTemplate): string {
  const f = fields(template);
  const { w, h } = labelDims(template);

  const labelsHtml = cartons.map(c => {
    const extraRows = [
      f.show_style  && c.style_no  ? `<div class="label-row"><span class="lbl">Style</span><span class="val">${c.style_no}</span></div>` : "",
      f.show_color  && c.color     ? `<div class="label-row"><span class="lbl">Color</span><span class="val">${c.color}</span></div>` : "",
      f.show_po     && c.po_number ? `<div class="label-row"><span class="lbl">PO</span><span class="val">${c.po_number}</span></div>` : "",
      f.show_carton ? `<div class="label-row"><span class="lbl">Carton</span><span class="val">${c.carton_seq}</span></div>` : "",
      f.show_units  && c.total_units != null ? `<div class="label-row"><span class="lbl">Units</span><span class="val">${c.total_units}</span></div>` : "",
    ].join("");
    return `
      <div class="label">
        <div class="label-header">GS1 Shipping Carton Label</div>
        <div class="ai-prefix">(00)</div>
        <div class="barcode-box">${c.sscc}</div>
        <div class="barcode-human">${formatSscc18Display(c.sscc)}</div>
        <div class="label-fields">${extraRows}</div>
        <div class="label-footer">Carton ${c.carton_seq}</div>
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(batchName)} — SSCC Labels</title>
<style>${labelPageCss(w, h)}</style>
</head><body>
${labelsHtml}
<script>window.onload=function(){window.print();setTimeout(function(){window.close();},1200);};<\/script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Default template constants ────────────────────────────────────────────────

export const DEFAULT_GTIN_TEMPLATE: LabelTemplate = {
  id: "__default_gtin__",
  label_type: "pack_gtin",
  template_name: "Standard 4×6 PDF",
  label_width: "4",
  label_height: "6",
  printer_type: "pdf",
  barcode_format: "gtin14",
  human_readable_fields: {
    show_style: true, show_color: true, show_scale: true, show_channel: true,
    show_po: false,   show_carton: false, show_units: false,
  },
  is_default: true,
  created_at: "",
  updated_at: "",
};

export const DEFAULT_SSCC_TEMPLATE: LabelTemplate = {
  id: "__default_sscc__",
  label_type: "sscc",
  template_name: "Standard 4×6 PDF",
  label_width: "4",
  label_height: "6",
  printer_type: "pdf",
  barcode_format: "sscc18",
  human_readable_fields: {
    show_style: true, show_color: true, show_scale: false, show_channel: false,
    show_po: true,    show_carton: true, show_units: true,
  },
  is_default: true,
  created_at: "",
  updated_at: "",
};

// ── Browser-only: download + print ───────────────────────────────────────────
// These functions touch the DOM and are excluded from unit tests.

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function openPrintWindow(html: string): void {
  const win = window.open("", "_blank");
  if (!win) { alert("Please allow pop-ups to print labels."); return; }
  win.document.write(html);
  win.document.close();
}
