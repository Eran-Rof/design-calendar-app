// api/_lib/inventory/poLotSplit.js
//
// Lot numbers — Scenario 4 (4.4): split one PO line's quantity across N customer
// POs (lots), dividing it evenly on a FULL-CARTON basis. Each lot gets a whole
// number of cartons (as even as possible); any leftover partial carton rides on
// the first lot so the parts always sum back to the original qty.
//
// Pure + deterministic so it unit-tests cleanly and the endpoint stays thin.

/**
 * Split `qty` into `n` parts, each a whole-carton multiple where possible,
 * distributed as evenly as possible. The remainder (qty % cartonSize) is added
 * to the first part so Σ parts === qty exactly.
 *
 * @param {number} qty          total units on the line (>= 0)
 * @param {number} n            number of lots / customer POs to split across
 * @param {number} [cartonSize] units per full carton (default 24)
 * @returns {number[]}          length n; sums to floor(qty) (0s allowed)
 */
export function splitQtyByCartonEven(qty, n, cartonSize = 24) {
  const parts = Array.from({ length: Math.max(0, Math.floor(n)) }, () => 0);
  if (parts.length === 0) return parts;
  const total = Math.max(0, Math.floor(Number(qty) || 0));
  const cs = Math.floor(Number(cartonSize) || 0) > 0 ? Math.floor(cartonSize) : 1;
  const cartons = Math.floor(total / cs);
  const rem = total - cartons * cs;
  const base = Math.floor(cartons / parts.length);
  const extra = cartons % parts.length;
  for (let i = 0; i < parts.length; i++) parts[i] = (base + (i < extra ? 1 : 0)) * cs;
  parts[0] += rem; // leftover partial carton goes on the first lot
  return parts;
}

/**
 * Expand a set of PO lines into per-lot split lines. Each input line becomes up
 * to `lots.length` lines (zero-qty splits dropped), each carrying its lot_number
 * and an even full-carton share of the original qty. line_total_cents is
 * recomputed from the split qty; line_number is renumbered sequentially.
 *
 * @param {Array<{inventory_item_id?:string|null, description?:string|null,
 *   qty_ordered:number, unit_cost_cents:number, requested_ship_date?:string|null,
 *   vendor_confirmed_ship_date?:string|null}>} lines
 * @param {string[]} lots                customer PO numbers (lot per part), in order
 * @param {number} [cartonSize]
 * @returns {Array<object>}              new line rows (no purchase_order_id/line_number-final)
 */
export function splitLinesByLot(lines, lots, cartonSize = 24) {
  const cleanLots = (Array.isArray(lots) ? lots : []).map((l) => String(l ?? "").trim()).filter(Boolean);
  if (cleanLots.length === 0) return [];
  const out = [];
  let ln = 1;
  for (const line of lines || []) {
    const qty = Math.max(0, Math.floor(Number(line.qty_ordered) || 0));
    const unit = Math.round(Number(line.unit_cost_cents) || 0);
    const parts = splitQtyByCartonEven(qty, cleanLots.length, cartonSize);
    for (let i = 0; i < cleanLots.length; i++) {
      const q = parts[i];
      if (q <= 0) continue;
      out.push({
        line_number: ln++,
        inventory_item_id: line.inventory_item_id ?? null,
        description: line.description ?? null,
        qty_ordered: q,
        unit_cost_cents: unit,
        line_total_cents: q * unit,
        requested_ship_date: line.requested_ship_date ?? null,
        vendor_confirmed_ship_date: line.vendor_confirmed_ship_date ?? null,
        lot_number: cleanLots[i],
      });
    }
  }
  return out;
}
