// src/tanda/arInvoiceLineDetail.ts
//
// AR-invoice adapter over the shared invoice/bill body builder
// (lib/invoiceMatrixBody). Kept as the AR entry point (and its dedicated tests)
// while the actual per-style color × size grouping now lives in ONE shared
// builder used by both AR invoices and AP vendor bills — the CEO asked the AP
// body to be modeled after this AR body, so they share the grouping outright.
// AR maps its `unit_price_cents` / `line_total_cents` (string cents) into the
// builder's money-agnostic `unitCents` / `lineTotalCents`.

import {
  buildInvoiceMatrixBody,
  type InvoiceMatrixItem,
  type InvoiceMatrixCell,
  type InvoiceMatrixStyle,
  type InvoiceFlatLine,
  type InvoiceMatrixModel,
} from "./lib/invoiceMatrixBody";

/** One AR invoice line as returned by GET /api/internal/ar-invoices/:id. */
export type ArDetailLineInput = {
  inventory_item_id: string | null;
  quantity: number | null;
  unit_price_cents: string | null;
  line_total_cents: string | null;
  description: string | null;
};

/** Item-master fields resolved via /api/internal/items?ids=. */
export type ArDetailItem = InvoiceMatrixItem;

// Re-exported under the historical AR names so existing importers/tests are
// unchanged; the shape now also carries styleName / inseam / poNumbers.
export type ArMatrixCell = InvoiceMatrixCell;
export type ArMatrixStyle = InvoiceMatrixStyle;
export type ArFlatLine = InvoiceFlatLine;
export type ArLineDetailModel = InvoiceMatrixModel;

const num = (s: string | null | undefined): number | null =>
  s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;

/**
 * Build the AR invoice row-detail view model from its lines + the resolved item
 * master. A line is "matrixable" when its SKU resolves to a style + size, it has
 * a positive quantity, and a unit price (so a size grid + Ext $ are meaningful).
 * Everything else becomes a flat line.
 */
export function buildArLineDetail(
  lines: ArDetailLineInput[],
  itemsById: Map<string, ArDetailItem>,
): ArLineDetailModel {
  return buildInvoiceMatrixBody(
    lines.map((l) => ({
      inventory_item_id: l.inventory_item_id,
      quantity: l.quantity,
      unitCents: num(l.unit_price_cents),
      lineTotalCents: num(l.line_total_cents),
      description: l.description,
    })),
    itemsById,
  );
}
