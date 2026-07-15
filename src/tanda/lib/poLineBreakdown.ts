// src/tanda/lib/poLineBreakdown.ts
//
// Shared Purchase-Order line breakdown — the single source of truth for the
// per-style → color → size "Issued / Received / Open (remaining-to-ship)"
// rollup used by BOTH the read-only PO grid row expander (PoRowDetail) and the
// receipt-aware PO edit grid (PoReceiptLinesEditor). Extracted so the two share
// ONE grouping + remain-to-ship formula instead of re-deriving it.
//
//   Issued  = qty_ordered
//   Received (shipped/booked) = qty_received
//   Open (remain-to-ship)     = max(0, qty_ordered − qty_received)
//
// Matrix lines (a real style_code + size) group into the color×size grid;
// SKU-less pack / aggregate lines (no size) are returned separately as
// `unlinkedLines` so callers list them plainly rather than as broken cells.

import { canonSizeLabel } from "../../shared/sizeSort";

/** A decorated PO line — the shape the /purchase-orders/:id detail returns. */
export type PoBreakdownLine = {
  /** purchase_order_lines.id (present on server-decorated detail lines). */
  id?: string | null;
  inventory_item_id?: string | null;
  part_id?: string | null;
  style_code?: string | null;
  color?: string | null;
  size?: string | null;
  inseam?: string | null;
  sku_code?: string | null;
  description?: string | null;
  qty_ordered: number;
  qty_received?: number | null;
  unit_cost_cents?: number | null;
  lot_number?: string | null;
  requested_ship_date?: string | null;
  vendor_confirmed_ship_date?: string | null;
};

/** One color×size cell: the three qty + three $ metrics, plus the backing
 *  line(s) so an editor can write the revised quantities back to real lines. */
export type PoBreakdownCell = {
  ordered: number;
  received: number;
  remaining: number;
  orderedCost: number;
  receivedCost: number;
  remainingCost: number;
  /** Lines that fall in this cell (normally one; >1 only on rare lot splits). */
  lines: PoBreakdownLine[];
};

export type PoBreakdownStyle = {
  style: string;
  sizes: Set<string>;
  colors: Map<string, Map<string, PoBreakdownCell>>;
  lots: Set<string>;
};

export type PoBreakdown = {
  byStyle: Map<string, PoBreakdownStyle>;
  matrixLines: PoBreakdownLine[];
  unlinkedLines: PoBreakdownLine[];
};

/** Open (remaining-to-ship) quantity for one line — never negative. */
export function openQty(l: Pick<PoBreakdownLine, "qty_ordered" | "qty_received">): number {
  const ord = Number(l.qty_ordered) || 0;
  const rec = Number(l.qty_received) || 0;
  return Math.max(0, ord - rec);
}

/** Does this PO carry any receipts? Driven by the header status OR any per-line
 *  qty_received, so it holds even if one lags the other. */
export function poHasReceipts(
  status: string | null | undefined,
  lines: Pick<PoBreakdownLine, "qty_received">[],
): boolean {
  if (status === "partially_received" || status === "received") return true;
  return lines.some((l) => (Number(l.qty_received) || 0) > 0);
}

/** Is every open line fully received (a completed PO)? True only when there is
 *  at least one line and none of them has any remaining-to-ship quantity. */
export function poFullyReceived(
  status: string | null | undefined,
  lines: Pick<PoBreakdownLine, "qty_ordered" | "qty_received">[],
): boolean {
  if (status === "received") return true;
  if (lines.length === 0) return false;
  return lines.every((l) => openQty(l) <= 0) && lines.some((l) => (Number(l.qty_received) || 0) > 0);
}

/** Group PO lines into the per-style color×size Issued/Received/Open breakdown.
 *  Sizes are canonicalized (SML→SMALL) so legacy spellings collapse into one
 *  column. Lines with no style_code+size are returned as `unlinkedLines`. */
export function groupPoLines(lines: PoBreakdownLine[]): PoBreakdown {
  const matrixLines = lines.filter((l) => l.style_code && l.size);
  const unlinkedLines = lines.filter((l) => !(l.style_code && l.size));

  const byStyle = new Map<string, PoBreakdownStyle>();
  for (const l of matrixLines) {
    const style = l.style_code as string;
    const color = l.color || "—";
    const size = canonSizeLabel(l.size as string);
    let s = byStyle.get(style);
    if (!s) { s = { style, sizes: new Set(), colors: new Map(), lots: new Set() }; byStyle.set(style, s); }
    s.sizes.add(size);
    if (l.lot_number) s.lots.add(l.lot_number);
    let cm = s.colors.get(color);
    if (!cm) { cm = new Map(); s.colors.set(color, cm); }
    const cell = cm.get(size) || { ordered: 0, received: 0, remaining: 0, orderedCost: 0, receivedCost: 0, remainingCost: 0, lines: [] };
    const ord = Number(l.qty_ordered) || 0;
    const rec = Number(l.qty_received) || 0;
    const open = Math.max(0, ord - rec);
    const unit = Number(l.unit_cost_cents) || 0;
    cell.ordered += ord; cell.received += rec; cell.remaining += open;
    cell.orderedCost += ord * unit; cell.receivedCost += rec * unit; cell.remainingCost += open * unit;
    cell.lines.push(l);
    cm.set(size, cell);
  }
  return { byStyle, matrixLines, unlinkedLines };
}
