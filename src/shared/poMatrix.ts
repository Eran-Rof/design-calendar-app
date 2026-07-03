// src/shared/poMatrix.ts
//
// Pure transform: PO line items (Xoro payload shape — ItemNumber / Description /
// QtyOrder / UnitPrice / …) → a size matrix grouped by base part + color.
//
// Extracted verbatim from src/tanda/detail/poMatrixTab.tsx so the Tanda PO
// matrix and the vendor-portal PO matrix share ONE source of truth. Keep this
// dependency-light (only the shared size/prepack atoms) so any consumer can use
// it regardless of app.

import { itemQty, isLineClosed, lineDeliveryDate, normalizeSize, sizeSort } from "../utils/tandaTypes";
import { extractPpk } from "./prepack";

export interface PoMatrixRow {
  color: string;
  desc: string;
  /** size token → summed qty for this base+color+closed+delivery row */
  sizes: Record<string, number>;
  price: number;
  closed: boolean;
  delivery: string;
}

export interface PoMatrixParsedLine {
  base: string;
  color: string;
  size: string;
  qty: number;
  price: number;
  desc: string;
  closed: boolean;
  delivery: string;
}

export interface PoMatrix {
  /** base parts in first-seen order */
  bases: string[];
  byBase: Record<string, PoMatrixRow[]>;
  /** distinct size tokens, sorted with sizeSort (numeric asc, then alpha scale) */
  sizeOrder: string[];
  parsed: PoMatrixParsedLine[];
  /** sum of open-line qtys (pack grain) */
  totalPacks: number;
  /** sum of open-line qtys × PPK multiplier (unit grain) */
  totalUnits: number;
}

/**
 * Build the size matrix from a PO's line items.
 *
 * @param items             Array of Xoro-shaped PO line items (Items / PoLineArr).
 * @param headerDeliveryDate The PO header's expected-delivery date, used as the
 *                           per-line delivery fallback.
 */
export function buildPoMatrix(items: any[], headerDeliveryDate?: string | null): PoMatrix {
  const parsed: PoMatrixParsedLine[] = (items || []).map((item: any) => {
    // Strip trailing dashes first: some Xoro ItemNumbers carry one (e.g.
    // "PTYT0023C-Glacier-SML-", a blank-size data quirk). Without this the split
    // yields a trailing "" element, so parts.length===4 mis-reads "Glacier-SML"
    // as a two-word color with an empty size — the line then falls out of the
    // size matrix and renders as a broken/non-matrix row.
    const sku = (item.ItemNumber ?? "").replace(/-+$/, "");
    const parts = sku.split("-");
    const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
    const size = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
    const closed = isLineClosed(item);
    // Closed lines display their original ordered qty so they stay visible,
    // but they're segregated into their own rows and excluded from totals.
    const qty = closed ? (item.QtyOrder ?? 0) : itemQty(item);
    const delivery = (lineDeliveryDate(item, headerDeliveryDate ?? undefined) || "").slice(0, 10);
    return { base: parts[0] || sku, color, size, qty, price: item.UnitPrice ?? 0, desc: item.Description ?? "", closed, delivery };
  });

  const sizeSet = new Set<string>();
  parsed.forEach((p) => { if (p.size) sizeSet.add(p.size); });
  const sizeOrder = [...sizeSet].sort(sizeSort);

  const bases: string[] = [];
  const byBase: Record<string, PoMatrixRow[]> = {};
  parsed.forEach((p) => {
    if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
    // Split rows by closed-state AND delivery date so each row reflects a
    // single shipment date — required when a PO has staggered line deliveries.
    let row = byBase[p.base].find((r) => r.color === p.color && r.closed === p.closed && r.delivery === p.delivery);
    if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price, closed: p.closed, delivery: p.delivery }; byBase[p.base].push(row); }
    row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
  });

  const totalPacks = parsed.reduce((s, p) => s + (p.closed ? 0 : (p.qty ?? 0)), 0);
  const totalUnits = parsed.reduce((s, p) => {
    if (p.closed) return s;
    const mult = extractPpk(p.size) ?? 1;
    return s + (p.qty ?? 0) * mult;
  }, 0);

  return { bases, byBase, sizeOrder, parsed, totalPacks, totalUnits };
}

/** Unit-grain total for a single row's sizes map (qty × PPK multiplier). */
export function rowExplodedTotal(sizes: Record<string, number>): number {
  let total = 0;
  for (const [sz, qty] of Object.entries(sizes)) {
    total += (qty as number) * (extractPpk(sz) ?? 1);
  }
  return total;
}
