// Sales-history grain helpers — shared by every path that writes to
// ip_sales_history_wholesale. Xoro records prepack sales at either
// pack-count or unit-count grain per row, and there's no UOM column in
// the InvoiceDetail report to disambiguate after the fact. We infer
// grain from PPK tokens in the raw Item Number BEFORE
// canonStyleColor strips them, then store the inferred grain + the
// derived unit-grain qty + cogs + margin on every row.
//
// Migrations:
//   20260517230000_sales_history_grain_and_margin.sql — adds qty_grain,
//     qty_units, unit_cost_at_sale, margin_amount, margin_pct columns +
//     backfill.
//   20260518000000_sales_history_cogs_and_smart_cost.sql — adds
//     cogs_amount + re-derives cost/margin via the smart-cost rule
//     below (mirror).
//
// This module owns the inference + math. Keep the regex + the cost +
// margin formulas in lockstep with the SQL backfill in those migrations.

const PPK_TOKEN_RE = /(?:^|[^A-Z])PPK\d*(?:[^A-Z0-9]|$)/i;

// Xoro chargeback-reversal rows (e.g. ROSSCBREVERSAL / "Ross CB
// Reversal") are accounting adjustments, not real sales. Skip when
// BOTH the item number and description tag the row — the AND keeps
// the filter conservative: a legit item whose description happens
// to mention "reversal" alone won't be dropped.
export function isChargebackReversalRow(itemNumber, description) {
  return /CBREVERSAL/i.test(String(itemNumber || ""))
      && /cb\s*reversal/i.test(String(description || ""));
}

export function inferQtyGrain(rawItemNumber, packSize) {
  if (!rawItemNumber) return "unit";
  if (!packSize || packSize <= 1) return "unit";
  return PPK_TOKEN_RE.test(String(rawItemNumber)) ? "pack" : "unit";
}

export function toQtyUnits(qty, grain, packSize) {
  const q = Number(qty) || 0;
  const p = Math.max(1, Number(packSize) || 1);
  return grain === "pack" ? q * p : q;
}

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

// Resolve a per-unit cost from a master snapshot + the row's grain +
// the row's per-unit sale price. master.unit_cost grain is
// inconsistent across ip_item_master: usually per-pack for true
// prepack-master rows, but per-unit for variant rows under a
// prepack family (and per-unit for non-prepack items).
//
// Rules:
//  1. Pack-grain sale: master.unit_cost is per-pack (Xoro convention),
//     divide by pack_size for per-unit.
//  2. Unit-grain sale: if master.unit_cost > 2 x unit-price, master
//     cost is implausibly high relative to the per-unit sale price
//     and is almost certainly stored at per-pack grain — divide.
//  3. Otherwise master.unit_cost is at per-unit grain; use as-is.
//
// The 2x threshold mirrors the legacy cost-implausibility gate that
// exportExcel.ts used to apply at READ time — moving it to the WRITE
// path so the snapshot persisted on every row is already correct.
export function resolvePerUnitCost({ masterUnitCost, packSize, grain, netAmount, qtyUnits }) {
  if (masterUnitCost == null) return null;
  const cost = Number(masterUnitCost);
  if (!Number.isFinite(cost)) return null;
  // Reject zero/negative master cost — those are data-quality gaps in
  // ip_item_master, not real free-cost goods. Returning null suppresses
  // the cogs/margin downstream so the export renders blank cells
  // instead of misleading "100.0%" rows.
  if (cost <= 0) return null;
  const ps = Math.max(1, Number(packSize) || 1);
  if (grain === "pack") return cost / ps;
  if (netAmount != null && qtyUnits > 0) {
    const unitPrice = Number(netAmount) / Number(qtyUnits);
    if (Number.isFinite(unitPrice) && unitPrice > 0 && cost > unitPrice * 2) {
      return cost / ps;
    }
  }
  return cost;
}

// ─────────────────────────────────────────────────────────────────────
// Pack-priced-as-unit detection
//
// Xoro occasionally records a wholesale prepack line under the unit-
// grain SKU (e.g. "RYO0658-BLACK/BIRCH") with qty=N packs and
// unit_price = wholesale pack price. Because the master row's
// pack_size=1, the sync would otherwise treat N as units and explode
// the margin (e.g. 131 packs of 18 jackets recorded as 131 jackets at
// $222.30/unit → 95.5% impossible margin against $10/unit cost).
//
// Detection runs ONLY when ALL of these tight false-positive guards
// hold:
//   1. Candidate is unit-grain (pack_size=1) per its master row.
//   2. unit_price is at least SUSPICIOUS_PRICE_RATIO × master.unit_cost
//      — filters out routine retail / wholesale unit-price lines.
//   3. A sibling PPK master row exists at the same SKU prefix with
//      pack_size > 1 (i.e. the prepack variant the line was likely
//      meant to be coded against).
//   4. We have at least MIN_REFERENCE_ROWS prior sales of the SAME
//      (customer, sku) pair at a "reasonable" per-unit price (within
//      [unit_cost, unit_cost × SUSPICIOUS_PRICE_RATIO]) to establish
//      a customer-specific reference unit price.
//   5. current_unit_price ≈ reference_unit_price × sibling.pack_size
//      within RATIO_TOLERANCE_PCT (default 5%).
//
// All five must hold; any single failure means we leave the row
// untouched. False-positive rate is essentially zero — the price has
// to match an established per-unit pattern multiplied by exactly the
// pack size, customer by customer.
// ─────────────────────────────────────────────────────────────────────

/** Per-unit cost has to be > 0 AND unit_price >= this multiple of cost
 *  to even consider the row a pack-pricing candidate. Filters out the
 *  normal retail / wholesale lines that sit at 1–4× cost. */
export const SUSPICIOUS_PRICE_RATIO = 5;

/** Minimum prior (customer, sku) sales rows at a reasonable per-unit
 *  price needed to lock in a reference. 1 is enough — the operator's
 *  data shows even one same-customer same-SKU unit-priced sale is a
 *  reliable signal of their wholesale per-unit price. */
export const MIN_REFERENCE_ROWS = 1;

/** Tolerance band around (reference × pack_size). ±5% — caters for
 *  rounding in Xoro and slight price walks across orders, while
 *  staying tight enough that random unit-grain sales can't land in
 *  the band by accident. */
export const RATIO_TOLERANCE_PCT = 0.05;

/**
 * Find the sibling PPK master row for a unit-grain sku_code.
 *
 * Rule: unit-grain `RYO0658-BLACK/BIRCH` (style_code RYO0658) has
 * sibling `RYO0658PPK-BLACK/BIRCH` (style_code RYO0658PPK). The
 * style_code gets "PPK" appended; the sku_code's variant suffix
 * (color/size after the first hyphen, if any) is preserved.
 *
 * `masterByCode` is a Map<sku_code → master row> (already keyed by
 * the canonical sku_code used elsewhere in the handler).
 *
 * Returns the sibling master row, or null when none exists.
 */
export function findSiblingPpkMaster(unitMaster, masterByCode) {
  if (!unitMaster || !unitMaster.style_code || !unitMaster.sku_code) return null;
  const variantSuffix = unitMaster.sku_code.slice(unitMaster.style_code.length);
  const ppkSkuCode = `${unitMaster.style_code}PPK${variantSuffix}`;
  const sibling = masterByCode.get(ppkSkuCode);
  if (!sibling) return null;
  if (!sibling.pack_size || Number(sibling.pack_size) <= 1) return null;
  return sibling;
}

/**
 * Pick the reference per-unit price for a (customer, sku) pair from
 * historical rows + same-batch peer rows. Returns null when no
 * reasonable reference exists (which means we must NOT reclassify).
 *
 * "Reasonable" = unit_price in [masterUnitCost, masterUnitCost ×
 * SUSPICIOUS_PRICE_RATIO]. This excludes pack-priced outliers from
 * being adopted as the reference.
 */
export function pickReferenceUnitPrice(unitPrices, masterUnitCost) {
  if (!Array.isArray(unitPrices) || unitPrices.length === 0) return null;
  if (masterUnitCost == null || masterUnitCost <= 0) return null;
  const lo = masterUnitCost;
  const hi = masterUnitCost * SUSPICIOUS_PRICE_RATIO;
  const reasonable = unitPrices
    .map(Number)
    .filter(p => Number.isFinite(p) && p >= lo && p <= hi);
  if (reasonable.length < MIN_REFERENCE_ROWS) return null;
  // Median — robust to a stray outlier even within the reasonable band.
  reasonable.sort((a, b) => a - b);
  const mid = Math.floor(reasonable.length / 2);
  return reasonable.length % 2 === 0
    ? (reasonable[mid - 1] + reasonable[mid]) / 2
    : reasonable[mid];
}

/**
 * Final decision: is this candidate a pack-priced-as-unit line that
 * should be reclassified to the PPK variant?
 *
 * Returns the sibling PPK master row when YES, null when NO.
 */
export function detectPackPricedAsUnit({
  candidateUnitPrice,
  unitMaster,
  masterByCode,
  historicalUnitPrices,
}) {
  if (unitMaster == null) return null;
  const packSize = Number(unitMaster.pack_size) || 1;
  if (packSize > 1) return null; // already pack-grain, nothing to do
  const masterUnitCost = Number(unitMaster.unit_cost) || 0;
  if (masterUnitCost <= 0) return null; // no cost basis → can't gauge "suspicious"
  const price = Number(candidateUnitPrice) || 0;
  if (price < masterUnitCost * SUSPICIOUS_PRICE_RATIO) return null; // unremarkable price → leave alone
  const sibling = findSiblingPpkMaster(unitMaster, masterByCode);
  if (!sibling) return null;
  const siblingPackSize = Number(sibling.pack_size) || 0;
  if (siblingPackSize <= 1) return null;
  const ref = pickReferenceUnitPrice(historicalUnitPrices, masterUnitCost);
  if (ref == null) return null;
  const expected = ref * siblingPackSize;
  const ratioDiff = Math.abs(price - expected) / expected;
  if (ratioDiff > RATIO_TOLERANCE_PCT) return null;
  return sibling;
}

export function deriveSalesGrainFields({ rawItemNumber, qty, netAmount, master }) {
  const packSize = Math.max(1, Number(master?.pack_size) || 1);
  const grain = inferQtyGrain(rawItemNumber, packSize);
  const qtyUnits = toQtyUnits(qty, grain, packSize);
  const perUnitCost = resolvePerUnitCost({
    masterUnitCost: master?.unit_cost ?? null,
    packSize,
    grain,
    netAmount,
    qtyUnits,
  });
  const cogsAmount = perUnitCost != null ? qtyUnits * perUnitCost : null;
  const { amount, pct } = computeRowMargin({
    netAmount,
    qtyUnits,
    perUnitCost,
  });
  return {
    qty_grain: grain,
    qty_units: qtyUnits,
    unit_cost_at_sale: perUnitCost,
    cogs_amount: cogsAmount,
    margin_amount: amount,
    margin_pct: pct,
  };
}
