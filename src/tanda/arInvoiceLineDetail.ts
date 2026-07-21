// src/tanda/arInvoiceLineDetail.ts
//
// Pure grouping logic behind the AR Invoices row expander (the ▸ carrot detail).
// Mirrors the PO row expander (PoRowDetail): AR invoice lines that resolve to a
// sized apparel item (style + size) are grouped into a per-style color × size
// grid; everything else (amount-only charges, non-apparel SKUs, SKUs we can't
// resolve) falls back to a flat line list. Extracted as a pure function so the
// grouping is unit-tested independently of React and reuses the SAME size
// canonicalization / ordering as every other size matrix.

import { canonSizeLabel, compareSizes } from "../shared/sizeSort";
import { titleCaseColor } from "./lib/colorGroup";

/** One AR invoice line as returned by GET /api/internal/ar-invoices/:id. */
export type ArDetailLineInput = {
  inventory_item_id: string | null;
  quantity: number | null;
  unit_price_cents: string | null;
  line_total_cents: string | null;
  description: string | null;
};

/** Item-master fields resolved via /api/internal/items?ids=. */
export type ArDetailItem = {
  id?: string;
  sku_code?: string;
  style_code?: string | null;
  description?: string | null;
  color?: string | null;
  size?: string | null;
  inseam?: string | null;
};

export type ArMatrixCell = { qty: number; extCents: number };

export type ArMatrixStyle = {
  styleCode: string;
  /** Canonical size columns in scale order. */
  sizes: string[];
  /** color → (canonical size → cell). */
  colors: Map<string, Map<string, ArMatrixCell>>;
};

export type ArFlatLine = {
  label: string;
  qty: number | null;
  unitCents: number | null;
  extCents: number;
};

export type ArLineDetailModel = { styles: ArMatrixStyle[]; flat: ArFlatLine[] };

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
  const styleMap = new Map<
    string,
    { sizes: Set<string>; colors: Map<string, Map<string, ArMatrixCell>> }
  >();
  const flat: ArFlatLine[] = [];

  for (const l of lines) {
    const item = l.inventory_item_id ? itemsById.get(l.inventory_item_id) : undefined;
    const qty = l.quantity != null ? Number(l.quantity) : 0;
    const unitCents =
      l.unit_price_cents != null && l.unit_price_cents !== ""
        ? Number(l.unit_price_cents)
        : null;
    const matrixable = !!item?.style_code && !!item?.size && qty > 0 && unitCents != null;

    if (matrixable && item) {
      const style = item.style_code as string;
      // Title-case the colorway so a CASE variant ("GREY" vs "Grey") merges into
      // ONE color row instead of splitting into two partial-size rows. The key
      // doubles as the display label; title case both folds case and reads well.
      const color = titleCaseColor(item.color) || "—";
      const size = canonSizeLabel(item.size as string);
      let s = styleMap.get(style);
      if (!s) { s = { sizes: new Set(), colors: new Map() }; styleMap.set(style, s); }
      s.sizes.add(size);
      let cm = s.colors.get(color);
      if (!cm) { cm = new Map(); s.colors.set(color, cm); }
      const cell = cm.get(size) || { qty: 0, extCents: 0 };
      cell.qty += qty;
      cell.extCents += qty * (unitCents as number);
      cm.set(size, cell);
    } else {
      let extCents = 0;
      if (l.line_total_cents != null && l.line_total_cents !== "") extCents = Number(l.line_total_cents);
      else if (unitCents != null && qty) extCents = qty * unitCents;
      flat.push({
        label: l.description || item?.sku_code || item?.description || "(line)",
        qty: l.quantity != null ? Number(l.quantity) : null,
        unitCents,
        extCents,
      });
    }
  }

  const styles: ArMatrixStyle[] = [...styleMap.entries()].map(([styleCode, s]) => ({
    styleCode,
    sizes: [...s.sizes].sort(compareSizes),
    colors: s.colors,
  }));

  return { styles, flat };
}
