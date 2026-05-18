// Sales-history grain helpers — shared by every path that writes to
// ip_sales_history_wholesale. Xoro records prepack sales at either
// pack-count or unit-count grain per row, and there's no UOM column in
// the InvoiceDetail report to disambiguate after the fact. We infer
// grain from PPK tokens in the raw Item Number BEFORE
// canonStyleColor strips them, then store the inferred grain + the
// derived unit-grain qty + margin on every row.
//
// Migration 20260517230000_sales_history_grain_and_margin.sql adds the
// schema. This module owns the inference + math. Keep the regex + the
// margin formula in lockstep with the SQL backfill in that migration.

// Match any `PPK<digits>` token in an Item Number, regardless of which
// segment it sits in. ROF historically wrote PPK in the size suffix
// (e.g. 'RYG0123-Black-PPK24') and modernly writes it in the style code
// (e.g. 'RYG1768PPK' — PPK directly follows the style digits, no dash).
// Either marks the line as pack-grain. The boundary check is "not a
// letter" (digits + separators OK) so a style ending in digits-then-PPK
// matches, while a longer word like 'APPKEEPER' does not.
const PPK_TOKEN_RE = /(?:^|[^A-Z])PPK\d*(?:[^A-Z0-9]|$)/i;

// Returns 'pack' when the raw Item Number contains a PPK token AND the
// master record is actually a prepack (pack_size > 1). 'unit' otherwise.
// The pack_size guard prevents false-positive when an item carries a
// PPK token in its description but isn't a real prepack.
export function inferQtyGrain(rawItemNumber, packSize) {
  if (!rawItemNumber) return "unit";
  if (!packSize || packSize <= 1) return "unit";
  return PPK_TOKEN_RE.test(String(rawItemNumber)) ? "pack" : "unit";
}

// Normalise a raw qty (Xoro grain) to unit grain using the inferred
// grain + pack_size. Pack rows multiply, unit rows pass through.
export function toQtyUnits(qty, grain, packSize) {
  const q = Number(qty) || 0;
  const p = Math.max(1, Number(packSize) || 1);
  return grain === "pack" ? q * p : q;
}

// Compute per-row margin from net_amount, unit-grain qty, and per-unit
// cost snapshot. Returns { amount, pct } where amount is in $ and pct
// is a fraction (0.25 = 25%). Returns null fields when inputs are
// missing or net_amount is non-positive.
//
// Cost basis: pass `master_unit_cost / pack_size` so the per-unit cost
// is consistent regardless of whether the master records per-pack or
// per-unit prices. (ROF master generally records per-pack cost for
// prepacks; dividing by pack_size yields per-unit.)
export function computeRowMargin({ netAmount, qtyUnits, perUnitCost }) {
  if (netAmount == null || qtyUnits == null || perUnitCost == null) {
    return { amount: null, pct: null };
  }
  const net = Number(netAmount);
  const qu = Number(qtyUnits);
  const cost = Number(perUnitCost);
  if (!Number.isFinite(net) || !Number.isFinite(qu) || !Number.isFinite(cost)) {
    return { amount: null, pct: null };
  }
  if (net <= 0) return { amount: null, pct: null };
  const amount = net - qu * cost;
  const pct = amount / net;
  return { amount, pct };
}

// Convenience: take a raw Xoro line + a master snapshot and return the
// full set of derived columns the sync handlers persist. Keeps the
// inference + margin math in one call site so handlers stay slim.
//
// master: { pack_size, unit_cost } or null/undefined if the item
// wasn't found (caller usually rejects the row earlier).
export function deriveSalesGrainFields({ rawItemNumber, qty, netAmount, master }) {
  const packSize = Math.max(1, Number(master?.pack_size) || 1);
  const grain = inferQtyGrain(rawItemNumber, packSize);
  const qtyUnits = toQtyUnits(qty, grain, packSize);
  const perUnitCost = master?.unit_cost != null
    ? Number(master.unit_cost) / packSize
    : null;
  const { amount, pct } = computeRowMargin({
    netAmount,
    qtyUnits,
    perUnitCost,
  });
  return {
    qty_grain: grain,
    qty_units: qtyUnits,
    unit_cost_at_sale: perUnitCost,
    margin_amount: amount,
    margin_pct: pct,
  };
}
