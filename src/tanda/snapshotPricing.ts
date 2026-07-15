// Per-column cost/price basis for the Inventory-Snapshot totals strip.
//
// Each quantity column (On Hand / Allocated / On SO / ATS / On PO / ATS-incl /
// Sold / Purchased / In Trnst) is valued from its OWN credible source rather
// than one blanket price/cost, so the Avrg Sale, Avg Cost and Avg Mrgn totals
// reflect what the units in that column actually sell / cost for:
//
//   Avrg Sale (colPriceCents)
//     On SO  → open_so_price_cents  (avg of the OPEN orders)
//     Sold   → sold_price_cents     (actual sold price)
//     others → sale_price_cents     (qty-weighted avg SO price = representative
//              wholesale). Previously these used the single most-recent SO line,
//              which is an outlier and read $12–17 while goods sell for ~$7.
//
//   Avg Cost (colCostCents)
//     On PO / In Trnst → on_po_cost_cents (actual open-PO unit cost → ties to
//              the PO grid), falling back to avg_cost_cents when a colour has no
//              priced open PO line.
//     others          → avg_cost_cents (item-master blended avg — in-inventory
//              carrying cost).
//
// Null return → those units carry no known price/cost and are excluded from that
// column's average (no dilution of the per-unit mean).

// Structural subset of a snapshot row — the fields these helpers read. The real
// SnapshotRow / MergedRow satisfy this.
export type PricedSnapshotRow = {
  avg_cost_cents: number | null;
  sale_price_cents: number | null;
  open_so_price_cents?: number | null;
  sold_price_cents?: number | null;
  on_po_cost_cents?: number | null;
};

function finite(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : v;
}

// Per-each SALE price (cents) a given quantity column is valued at, or null.
export function colPriceCents(r: PricedSnapshotRow, k: string): number | null {
  return finite(
    k === "on_so" ? r.open_so_price_cents
      : k === "sold" ? r.sold_price_cents
      : r.sale_price_cents,
  );
}

// Per-each COST (cents) a given quantity column is valued at, or null. On PO /
// In Trnst are inbound PO goods → the actual open-PO unit cost (fallback to the
// item-master avg when a colour has no priced PO line); everything else is the
// item-master blended avg cost.
export function colCostCents(r: PricedSnapshotRow, k: string): number | null {
  return finite(
    (k === "on_po" || k === "in_transit")
      ? (r.on_po_cost_cents ?? r.avg_cost_cents)
      : r.avg_cost_cents,
  );
}
