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
import { titleCaseColor } from "./colorGroup";

/** A decorated PO line — the shape the /purchase-orders/:id detail returns. */
export type PoBreakdownLine = {
  /** purchase_order_lines.id (present on server-decorated detail lines). */
  id?: string | null;
  inventory_item_id?: string | null;
  part_id?: string | null;
  style_code?: string | null;
  /** Style description (style_master.style_name || description) — shown in the
   *  style block header so a received PO reads by name, not just the bare code. */
  style_name?: string | null;
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
  /** First non-null style_name across this style's lines (for the block header). */
  styleName: string | null;
  sizes: Set<string>;
  /** The single inseam shared by EVERY matrix line of this style, when they all
   *  carry the same non-null inseam — shown once in the style header (a jeans
   *  buyer needs the inseam, e.g. 30, which is otherwise invisible because it is
   *  not a size column). null when the style has no inseam (tops / shorts) or
   *  MIXES inseams — then the inseam is appended to each color row label. */
  inseam: string | null;
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

  // Pass 1 — per style, the distinct non-null inseams seen + whether any line has
  // none. Drives whether the inseam is shown ONCE in the style header (every line
  // shares one inseam) or appended to each color row label (the PO mixes inseams
  // of one base style, so Black/30 and Black/32 must stay distinct rows).
  const inseamInfo = new Map<string, { set: Set<string>; hasNull: boolean }>();
  for (const l of matrixLines) {
    const style = l.style_code as string;
    let info = inseamInfo.get(style);
    if (!info) { info = { set: new Set(), hasNull: false }; inseamInfo.set(style, info); }
    const ins = l.inseam == null ? "" : String(l.inseam).trim();
    if (ins) info.set.add(ins); else info.hasNull = true;
  }
  const headerInseamOf = (style: string): string | null => {
    const info = inseamInfo.get(style);
    return info && info.set.size === 1 && !info.hasNull ? [...info.set][0] : null;
  };
  const perRowInseamOf = (style: string): boolean => {
    const info = inseamInfo.get(style);
    if (!info) return false;
    return info.set.size > 1 || (info.set.size >= 1 && info.hasNull);
  };

  const byStyle = new Map<string, PoBreakdownStyle>();
  for (const l of matrixLines) {
    const style = l.style_code as string;
    const ins = l.inseam == null ? "" : String(l.inseam).trim();
    // Row label: plain color, plus the inseam when this style MIXES inseams (so a
    // uniform-inseam style shows its inseam once in the header, not on every row).
    // Title-case the colorway so a future CASE variant ("BLACK" vs "Black") can
    // never split one colorway into two partial-size rows — the key doubles as
    // the display label, and title case both merges case variants and reads well.
    const colorDisp = titleCaseColor(l.color) || "—";
    const color = perRowInseamOf(style) && ins ? `${colorDisp} · ${ins}"` : colorDisp;
    const size = canonSizeLabel(l.size as string);
    let s = byStyle.get(style);
    if (!s) { s = { style, styleName: null, sizes: new Set(), inseam: headerInseamOf(style), colors: new Map(), lots: new Set() }; byStyle.set(style, s); }
    if (!s.styleName && l.style_name) s.styleName = String(l.style_name).trim() || null;
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

/** Grand ORDERED-cost total (cents) for a whole PO breakdown — every matrix cell
 *  plus every unlinked line (qty_ordered × unit_cost_cents). Grain-invariant: a
 *  pack-grain line's qty is packs and its unit_cost is per-pack, so the product
 *  is the same money whether or not the view is exploded to eaches. Powers the
 *  receipt view's grand $ total (parity with the normal matrix line body). */
export function poBreakdownGrandTotalCents(breakdown: PoBreakdown): number {
  let cents = 0;
  for (const s of breakdown.byStyle.values())
    for (const cm of s.colors.values())
      for (const cell of cm.values()) cents += cell.orderedCost;
  for (const l of breakdown.unlinkedLines)
    cents += (Number(l.qty_ordered) || 0) * (Number(l.unit_cost_cents) || 0);
  return Math.round(cents);
}

/** One posted receipt's contribution: a date (YYYY-MM-DD) + qty received. */
export type ReceiptDatePoint = { date: string; qty: number };
/** LRD (Last Received Date) summary derived from a PO's POSTED receipts. */
export type ReceiptDateSummary = {
  /** Newest posted receipt_date (YYYY-MM-DD), or null when none. */
  lastReceivedDate: string | null;
  /** Per-date received quantities, OLDEST → NEWEST (many receipts on one date
   *  collapse into a single summed row). */
  byDate: ReceiptDatePoint[];
};

/** Collapse a PO's posted receipts (one point per receipt, possibly several on
 *  one date) into per-date totals + the last received date. Pure so the receipt
 *  view's LRD chip + hover breakdown are unit-testable without the network. */
export function deriveReceiptDateSummary(receipts: ReceiptDatePoint[] | null | undefined): ReceiptDateSummary {
  const byDateMap = new Map<string, number>();
  for (const r of receipts || []) {
    const d = (r?.date || "").trim();
    if (!d) continue;
    byDateMap.set(d, (byDateMap.get(d) || 0) + (Number(r.qty) || 0));
  }
  const byDate = [...byDateMap.entries()]
    .map(([date, qty]) => ({ date, qty }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { lastReceivedDate: byDate.length ? byDate[byDate.length - 1].date : null, byDate };
}
