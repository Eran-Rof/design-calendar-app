// src/tanda/lib/invoiceMatrixBody.ts
//
// Shared invoice/bill BODY builder — the single grouping behind every AR invoice
// and AP vendor-bill line body in the suite. A document stores one opaque
// inventory_item_id + qty + money per line; the caller resolves those ids to the
// SKU's { style_code, description, color, size, inseam } (via /items?ids=) and
// feeds them here. Lines that resolve to a real style + size with a positive qty
// and a unit price/cost group into a per-style color × size grid (the same shape
// as the PO body, groupPoLines); everything else (amount-only charges, expense
// lines, non-apparel or unresolved SKUs, size-NULL color-level SKUs) falls back
// to a flat line list so nothing is dropped.
//
// This is the AR model the CEO asked the AP body to be modeled after — extracted
// as a PURE function so the grouping is unit-tested independently of React and
// reuses the SAME size canonicalization/ordering (sizeSort), colorway case-fold
// (colorGroup) and inseam header/roll-up convention (poLineBreakdown) as every
// other size matrix. AR feeds unit_price_cents as `unitCents`; AP feeds
// unit_cost_cents — the builder is money-agnostic so both share one code path.

import { canonSizeLabel, compareSizes } from "../../shared/sizeSort";
import { titleCaseColor } from "./colorGroup";

/** One document line, normalized. The caller maps the AR `unit_price_cents` or
 *  the AP `unit_cost_cents` into `unitCents` so this builder never has to know
 *  which side it is on. */
export type InvoiceMatrixLineInput = {
  inventory_item_id: string | null;
  quantity: number | null;
  /** Money per each in CENTS (AR unit price / AP unit cost). */
  unitCents: number | null;
  /** Optional pre-computed line total in cents — used for amount-only flat lines
   *  (freight / fees / discounts) that carry a total but no qty × unit. */
  lineTotalCents?: number | null;
  description?: string | null;
  /** Originating PO number (AP bill lines carry invoice_line_items.po_number). */
  poNumber?: string | null;
};

/** SKU fields resolved from ip_item_master via /api/internal/items?ids=. */
export type InvoiceMatrixItem = {
  id?: string;
  sku_code?: string | null;
  style_code?: string | null;
  description?: string | null;
  color?: string | null;
  size?: string | null;
  inseam?: string | null;
};

export type InvoiceMatrixCell = { qty: number; extCents: number };

export type InvoiceMatrixStyle = {
  styleCode: string;
  /** First non-empty line/SKU description for this style — the human name shown
   *  next to the (blue) style code so a body reads by name, not just the code. */
  styleName: string | null;
  /** The one inseam shared by EVERY matrix line of this style, shown once in the
   *  style header (jeans buyers need the inseam — e.g. 30 — which is otherwise
   *  invisible as it is not a size column). null when the style has no inseam or
   *  MIXES inseams; then the inseam is appended to each color row label. */
  inseam: string | null;
  /** Canonical size columns in scale order. */
  sizes: string[];
  /** color (display + group key) → (canonical size → cell). */
  colors: Map<string, Map<string, InvoiceMatrixCell>>;
  /** Distinct originating PO numbers across this style's lines (AP bills). */
  poNumbers: string[];
};

export type InvoiceFlatLine = {
  label: string;
  qty: number | null;
  unitCents: number | null;
  extCents: number;
};

export type InvoiceMatrixModel = { styles: InvoiceMatrixStyle[]; flat: InvoiceFlatLine[] };

/** Build the per-style color × size body model from a document's lines + its
 *  resolved item master. A line is "matrixable" when its SKU resolves to a style
 *  + size, has a positive quantity, and carries a unit price/cost (so a size grid
 *  + Ext $ are meaningful). Everything else becomes a flat line. */
export function buildInvoiceMatrixBody(
  lines: InvoiceMatrixLineInput[],
  itemsById: Map<string, InvoiceMatrixItem>,
): InvoiceMatrixModel {
  type Row = {
    line: InvoiceMatrixLineInput;
    item?: InvoiceMatrixItem;
    qty: number;
    unitCents: number | null;
  };
  const rows: Row[] = lines.map((line) => {
    const item = line.inventory_item_id ? itemsById.get(line.inventory_item_id) : undefined;
    const qty = line.quantity != null ? Number(line.quantity) : 0;
    const unitCents =
      line.unitCents != null && Number.isFinite(Number(line.unitCents)) ? Number(line.unitCents) : null;
    return { line, item, qty, unitCents };
  });

  const isMatrixable = (r: Row) =>
    !!r.item?.style_code && !!r.item?.size && r.qty > 0 && r.unitCents != null;

  // Pass 1 — per-style inseam disposition (one header chip vs per-row label),
  // the same convention groupPoLines uses so a jeans bill/invoice reads the same
  // as the PO body.
  const inseamInfo = new Map<string, { set: Set<string>; hasNull: boolean }>();
  for (const r of rows) {
    if (!isMatrixable(r)) continue;
    const style = r.item!.style_code as string;
    let info = inseamInfo.get(style);
    if (!info) { info = { set: new Set(), hasNull: false }; inseamInfo.set(style, info); }
    const ins = r.item!.inseam == null ? "" : String(r.item!.inseam).trim();
    if (ins) info.set.add(ins); else info.hasNull = true;
  }
  const headerInseamOf = (style: string): string | null => {
    const info = inseamInfo.get(style);
    return info && info.set.size === 1 && !info.hasNull ? [...info.set][0] : null;
  };
  const perRowInseam = (style: string): boolean => {
    const info = inseamInfo.get(style);
    if (!info) return false;
    return info.set.size > 1 || (info.set.size >= 1 && info.hasNull);
  };

  type Acc = {
    styleName: string | null;
    inseam: string | null;
    sizes: Set<string>;
    colors: Map<string, Map<string, InvoiceMatrixCell>>;
    pos: Set<string>;
  };
  const styleMap = new Map<string, Acc>();
  const flat: InvoiceFlatLine[] = [];

  for (const r of rows) {
    if (isMatrixable(r)) {
      const item = r.item!;
      const style = item.style_code as string;
      const ins = item.inseam == null ? "" : String(item.inseam).trim();
      // Title-case the colorway so a CASE variant ("GREY" vs "Grey") merges into
      // ONE color row instead of splitting into partial-size rows; the key
      // doubles as the display label. Append the inseam only when this style
      // MIXES inseams (uniform inseam shows once in the header).
      const colorDisp = titleCaseColor(item.color) || "—";
      const color = perRowInseam(style) && ins ? `${colorDisp} · ${ins}"` : colorDisp;
      const size = canonSizeLabel(item.size as string);
      let s = styleMap.get(style);
      if (!s) {
        s = { styleName: null, inseam: headerInseamOf(style), sizes: new Set(), colors: new Map(), pos: new Set() };
        styleMap.set(style, s);
      }
      const name = (r.line.description ?? "").trim() || (item.description ?? "").trim();
      if (!s.styleName && name) s.styleName = name;
      if (r.line.poNumber && String(r.line.poNumber).trim()) s.pos.add(String(r.line.poNumber).trim());
      s.sizes.add(size);
      let cm = s.colors.get(color);
      if (!cm) { cm = new Map(); s.colors.set(color, cm); }
      const cell = cm.get(size) || { qty: 0, extCents: 0 };
      cell.qty += r.qty;
      cell.extCents += r.qty * (r.unitCents as number);
      cm.set(size, cell);
    } else {
      let extCents = 0;
      if (r.line.lineTotalCents != null && Number.isFinite(Number(r.line.lineTotalCents))) {
        extCents = Number(r.line.lineTotalCents);
      } else if (r.unitCents != null && r.qty) {
        extCents = r.qty * r.unitCents;
      }
      flat.push({
        label: (r.line.description ?? "").trim() || r.item?.sku_code || r.item?.description || "(line)",
        qty: r.line.quantity != null ? Number(r.line.quantity) : null,
        unitCents: r.unitCents,
        extCents,
      });
    }
  }

  const styles: InvoiceMatrixStyle[] = [...styleMap.entries()].map(([styleCode, s]) => ({
    styleCode,
    styleName: s.styleName,
    inseam: s.inseam,
    sizes: [...s.sizes].sort(compareSizes),
    colors: s.colors,
    poNumbers: [...s.pos].filter(Boolean).sort(),
  }));

  return { styles, flat };
}
