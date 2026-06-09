// Canonical PDF export for the whole app.
//
// Mirrors the Excel "ATS look" (src/shared/excelLogo.ts) — same dark-blue
// header band, zebra rows and grey grid — and stamps the Ring of Fire logo at
// the top of every page. Built on jsPDF + jspdf-autotable.

import { jsPDF } from "jspdf";
import autoTable, { type RowInput, type Styles } from "jspdf-autotable";
import { ROF_LOGO_DATA_URL, ROF_LOGO_ASPECT } from "./assets/rofLogo";

// Palette as RGB (jsPDF wants [r,g,b]) — kept in lockstep with excelLogo XLP.*
const RGB = {
  HEADER_FILL: [31, 73, 125] as [number, number, number], // 1F497D
  HEADER_TEXT: [255, 255, 255] as [number, number, number],
  ROW_EVEN: [238, 243, 250] as [number, number, number], // EEF3FA
  ROW_ODD: [255, 255, 255] as [number, number, number],
  GRID: [208, 216, 228] as [number, number, number], // D0D8E4
  KEY_TEXT: [31, 73, 125] as [number, number, number],
  BODY_TEXT: [26, 32, 42] as [number, number, number], // 1A202C
  NEG_TEXT: [192, 0, 0] as [number, number, number], // C00000
  MUTED: [100, 116, 139] as [number, number, number],
};

export type PdfAlign = "left" | "center" | "right";
export type PdfFormat = "qty" | "usd" | "pct" | "text";

export interface PdfColumn {
  header: string;
  key: string;
  align?: PdfAlign;
  format?: PdfFormat;
  /** Color negative numbers red (qty/usd columns). Default true for numeric formats. */
  colorNegative?: boolean;
}

export interface PdfSection {
  /** Optional sub-heading rendered above the table. */
  heading?: string;
  columns: PdfColumn[];
  rows: Record<string, unknown>[];
}

export interface PdfExportOpts {
  fileName: string;
  title: string;
  /** Defaults to "Generated <today>". Pass "" to suppress. */
  subtitle?: string;
  /** Key/value lines printed under the title (e.g. PO #, vendor). */
  meta?: Array<[string, string]>;
  sections: PdfSection[];
  orientation?: "portrait" | "landscape";
}

function fmtValue(v: unknown, format: PdfFormat | undefined): string {
  if (v == null || v === "") return "";
  if (format === "usd" && typeof v === "number")
    return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (format === "qty" && typeof v === "number")
    return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (format === "pct" && typeof v === "number")
    return (v * 100).toFixed(1) + "%";
  return String(v);
}

function todayLong(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const MARGIN = 36; // pt (~0.5in)
const LOGO_W = 150; // pt
const LOGO_H = LOGO_W / ROF_LOGO_ASPECT;

export function exportPdf(opts: PdfExportOpts): void {
  const orientation = opts.orientation ?? "portrait";
  const doc = new jsPDF({ orientation, unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();

  let cursorY = MARGIN;

  // ── Header band (logo + title) — drawn on the first page here, and on every
  // subsequent page via the didDrawPage hook below.
  const drawHeader = (): number => {
    let y = MARGIN;
    doc.addImage(ROF_LOGO_DATA_URL, "PNG", MARGIN, y, LOGO_W, LOGO_H);
    y += LOGO_H + 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...RGB.HEADER_FILL);
    doc.text(opts.title, MARGIN, y);
    y += 16;
    const sub = opts.subtitle ?? `Generated ${todayLong()}`;
    if (sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...RGB.MUTED);
      doc.text(sub, MARGIN, y);
      y += 12;
    }
    if (opts.meta && opts.meta.length) {
      doc.setFontSize(9);
      for (const [k, v] of opts.meta) {
        doc.setTextColor(...RGB.KEY_TEXT);
        doc.setFont("helvetica", "bold");
        doc.text(`${k}: `, MARGIN, y);
        const kw = doc.getTextWidth(`${k}: `);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...RGB.BODY_TEXT);
        doc.text(String(v), MARGIN + kw, y);
        y += 12;
      }
    }
    return y + 6;
  };

  cursorY = drawHeader();
  const headerBottom = cursorY;

  opts.sections.forEach((section, si) => {
    if (section.heading) {
      cursorY += si === 0 ? 0 : 10;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...RGB.HEADER_FILL);
      doc.text(section.heading, MARGIN, cursorY);
      cursorY += 6;
    }

    const head: RowInput[] = [section.columns.map((c) => c.header)];
    const body: RowInput[] = section.rows.map((row) =>
      section.columns.map((c) => fmtValue(row[c.key], c.format)),
    );

    const columnStyles: Record<number, Partial<Styles>> = {};
    section.columns.forEach((c, i) => {
      const numeric = c.format === "qty" || c.format === "usd" || c.format === "pct";
      columnStyles[i] = { halign: c.align ?? (numeric ? "right" : i === 0 ? "left" : "left") };
    });

    autoTable(doc, {
      head,
      body,
      startY: cursorY + 4,
      margin: { left: MARGIN, right: MARGIN, top: headerBottom },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 8,
        cellPadding: 3,
        lineColor: RGB.GRID,
        lineWidth: 0.5,
        textColor: RGB.BODY_TEXT,
        valign: "middle",
      },
      headStyles: {
        fillColor: RGB.HEADER_FILL,
        textColor: RGB.HEADER_TEXT,
        fontStyle: "bold",
        halign: "center",
        lineColor: RGB.HEADER_FILL,
      },
      alternateRowStyles: { fillColor: RGB.ROW_EVEN },
      bodyStyles: { fillColor: RGB.ROW_ODD },
      columnStyles,
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const col = section.columns[data.column.index];
        if (!col) return;
        // Emphasize the first column like the Excel "key" style.
        if (data.column.index === 0) {
          data.cell.styles.textColor = RGB.KEY_TEXT;
          data.cell.styles.fontStyle = "bold";
        }
        // Color negative numbers red.
        const numeric = col.format === "qty" || col.format === "usd" || col.format === "pct";
        const wantNeg = col.colorNegative ?? numeric;
        if (wantNeg) {
          const raw = section.rows[data.row.index]?.[col.key];
          if (typeof raw === "number" && raw < 0) {
            data.cell.styles.textColor = RGB.NEG_TEXT;
            data.cell.styles.fontStyle = "bold";
          }
        }
      },
      didDrawPage: (data) => {
        // Re-stamp the logo/title header on page breaks.
        if (data.pageNumber > 1) drawHeader();
        // Footer: page number.
        const page = doc.internal.pages.length - 1;
        doc.setFontSize(8);
        doc.setTextColor(...RGB.MUTED);
        doc.setFont("helvetica", "normal");
        doc.text(
          `Page ${data.pageNumber} of ${page}`,
          pageW - MARGIN,
          doc.internal.pageSize.getHeight() - 18,
          { align: "right" },
        );
      },
    });

    cursorY = (doc as any).lastAutoTable?.finalY ?? cursorY;
  });

  doc.save(opts.fileName);
}

// ── Convenience: single table straight from an array of objects ────────────
export interface SimplePdfOpts {
  fileName: string;
  title: string;
  subtitle?: string;
  meta?: Array<[string, string]>;
  orientation?: "portrait" | "landscape";
  /** Pretty header labels keyed by field; falls back to a title-cased key. */
  headers?: Record<string, string>;
  currencyKeys?: string[];
  qtyKeys?: string[];
}

export function exportObjectsPdf(rows: Record<string, unknown>[], opts: SimplePdfOpts): void {
  const fields = rows.length ? Object.keys(rows[0]) : [];
  const currency = new Set(opts.currencyKeys ?? []);
  const qty = new Set(opts.qtyKeys ?? []);
  const columns: PdfColumn[] = fields.map((f) => {
    let format: PdfFormat = "text";
    if (currency.has(f)) format = "usd";
    else if (qty.has(f)) format = "qty";
    else if (rows.some((r) => typeof r[f] === "number")) format = "qty";
    return { header: opts.headers?.[f] ?? prettyLabel(f), key: f, format };
  });
  exportPdf({
    fileName: opts.fileName,
    title: opts.title,
    subtitle: opts.subtitle,
    meta: opts.meta,
    orientation: opts.orientation,
    sections: [{ columns, rows }],
  });
}

function prettyLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bId\b/g, "ID")
    .replace(/\bSku\b/g, "SKU")
    .replace(/\bPo\b/g, "PO");
}
