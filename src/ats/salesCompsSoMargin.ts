// Client-side margin estimator for open SO contributions in Sales Comps.
//
// Open SOs (excelData.sos) carry sku / qty / unitPrice / totalPrice but
// NO cost — the server-side path (api/_handlers/sales/sync-invoices.js +
// api/_lib/sales-grain.js) is the only place row-level cost gets
// resolved from ip_item_avg_cost / ip_item_master at write time. When
// Sales Comps folds open SOs into TY revenue + qty for forward-looking
// windows, margin would otherwise stay zero, leaving the TY MRGN%
// column at "0.0%" in any view dominated by open commitments
// (forward windows, brand-new sub-categories with no shipped LY, etc.).
//
// This estimator mirrors the relevant slice of sales-grain.js using the
// data the client actually has: per-row master.unit_cost + master.pack_size
// from the item-master cache. ip_item_avg_cost is more authoritative but
// lives server-side — adding a round-trip just for the margin column on
// open SOs isn't justified for an estimate that flags itself as such in
// the UI.
//
// Cost-resolution rule (mirror of resolvePerUnitCost in sales-grain.js):
//
//   1. PPK-token routing (Pass 2a-pre semantics). If rawSku contains a
//      "PPK<digits>" token AND the resolved master is each-grain
//      (pack_size = 1), look up the PPK sibling via the same naming
//      candidates findSiblingPpkMaster generates. Use the sibling's
//      unit_cost + pack_size.
//
//   2. Grain inference. PPK token in rawSku AND effective master
//      pack_size > 1 → grain = "pack" (qty_units = qty × pack_size,
//      master.unit_cost is per-pack so divide by pack_size for per-each
//      cost). Otherwise → grain = "unit".
//
//   3. Unit-grain anomaly guard. If grain = "unit" but
//      master.unit_cost > 2 × unit_price (totalPrice / qty), master cost
//      is almost certainly stored at per-pack grain — divide by
//      pack_size. Mirrors the 2× threshold in resolvePerUnitCost.
//
//   4. Otherwise master.unit_cost is per-each — use as-is.
//
// Failure modes (return null + reason for the caveat-count UI):
//
//   - "no_master": no item-master record resolves at all (sku unknown or
//     cache not loaded). Margin contribution stays 0 — caller still
//     folds qty + revenue.
//   - "no_cost": master resolved but unit_cost is null/0. Same handling.
//
// Mirrored from api/_lib/sales-grain.js (parsePackSizeFromRaw,
// findSiblingPpkMaster, resolvePerUnitCost) — keep the rules here in
// lockstep with the server when sales-grain.js changes.

import type { ItemMasterRecord } from "./itemMasterLookup";

export type SoCostReason = "ok" | "no_master" | "no_cost";

export interface SoUnitCostResult {
  /** Per-each cost in dollars. null when no usable cost is available. */
  unitCostEach: number | null;
  reason: SoCostReason;
}

export interface SoMarginResult {
  /** Estimated margin in dollars. 0 when cost couldn't be resolved. */
  margin: number;
  /** Per-each cost actually used (null when not resolved). Exposed for
   *  callers that want to log / accumulate average cost. */
  unitCostEach: number | null;
  /** Effective per-each qty (qty × pack_size when grain = "pack"). */
  qtyUnits: number;
  /** True when a cost was resolved and folded into margin. False
   *  feeds the caveat-line "M had no resolvable cost" counter. */
  costResolved: boolean;
  reason: SoCostReason;
}

export type ResolveIdsFn = (sku: string) => string[];
export type GetMasterFn = (id: string) => ItemMasterRecord | null;

/** PPK token detector — matches both forms the server's inferQtyGrain
 *  treats as pack-grain triggers:
 *    - Glued form with no digits: `RYO0658PPK-BLACK`
 *    - Dash/digits form: `RBB1440N-BLACK-PPK48`
 *  Mirrors PPK_TOKEN_RE in api/_lib/sales-grain.js (which uses `\d*`
 *  so the glued form qualifies). The boundary rule keeps random style
 *  codes that happen to end in PPK-letters from triggering — PPK has
 *  to sit at a non-letter boundary on both sides. */
const PPK_TOKEN_RE = /(?:^|[^A-Z])PPK\d*(?:[^A-Z0-9]|$)/i;

export function hasPpkToken(rawSku: string): boolean {
  return PPK_TOKEN_RE.test(String(rawSku || ""));
}

/** Resolve the first usable master record from the cache. Returns null
 *  when the sku doesn't resolve at all or every id maps to a missing
 *  record (cache not loaded yet). */
function firstMaster(
  rawSku: string,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): ItemMasterRecord | null {
  const ids = resolveIds(rawSku);
  for (const id of ids) {
    const rec = getMaster(id);
    if (rec) return rec;
  }
  return null;
}

/** Try every PPK-sibling sku_code candidate findSiblingPpkMaster would
 *  generate, looking each up via resolveIds (which is keyed by sku_code
 *  in the cache's canonical/normalized form). Returns the first sibling
 *  whose pack_size > 1, mirroring the server-side gate. */
function findSiblingPpk(
  unitMaster: ItemMasterRecord,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): ItemMasterRecord | null {
  if (!unitMaster.style_code || !unitMaster.sku_code) return null;
  const variantSuffix = unitMaster.sku_code.slice(unitMaster.style_code.length);
  const candidates: string[] = [
    `${unitMaster.style_code}PPK${variantSuffix}`,
    `${unitMaster.style_code}-PPK${variantSuffix}`,
  ];
  // Mis-tagged-style_code fallback (sales-grain.js comments cover the
  // RBB1438N family where style_code = "RBB1438N-PPK" on the unit row).
  const lastDash = unitMaster.sku_code.lastIndexOf("-");
  if (lastDash > 0) {
    const prefix = unitMaster.sku_code.slice(0, lastDash);
    const colorSuf = unitMaster.sku_code.slice(lastDash);
    const trueStyle = prefix.replace(/-?PPK\d*$/i, "");
    if (trueStyle && trueStyle !== unitMaster.style_code) {
      candidates.push(`${trueStyle}PPK${colorSuf}`);
      candidates.push(`${trueStyle}-PPK${colorSuf}`);
    }
  }
  for (const code of candidates) {
    const ids = resolveIds(code);
    for (const id of ids) {
      const rec = getMaster(id);
      if (rec && Number(rec.pack_size) > 1) return rec;
    }
  }
  return null;
}

/**
 * Estimate per-each cost for an open SO row.
 *
 * Returns `{ unitCostEach, reason }`:
 *   - `unitCostEach`: dollars per each (multiply by qty_units for COGS).
 *     null when no usable cost was found.
 *   - `reason`: "ok" when a cost was resolved, "no_master" when the sku
 *     doesn't resolve at all, "no_cost" when the master row exists but
 *     has no unit_cost.
 *
 * The function is pure — takes the cache lookups as dependencies so the
 * test suite can inject a synthetic cache without touching the module-
 * level singletons in itemMasterLookup.ts.
 *
 * Note: the unit-grain price-anomaly guard (master.unit_cost > 2 ×
 * unit_price) is NOT applied here — it needs qty + netAmount which only
 * estimateSoMargin has in scope. Use estimateSoMargin for the
 * end-to-end calculation.
 */
export function estimateSoUnitCost(
  rawSku: string,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): SoUnitCostResult {
  let master = firstMaster(rawSku, resolveIds, getMaster);
  if (!master) return { unitCostEach: null, reason: "no_master" };

  // PPK-token routing (Pass 2a-pre): when the raw sku carries a
  // PPK<digits> token but we landed on an each-grain master, swap to
  // the sibling PPK master so cost + pack_size are pack-grain.
  if (hasPpkToken(rawSku) && (Number(master.pack_size) || 1) <= 1) {
    const sibling = findSiblingPpk(master, resolveIds, getMaster);
    if (sibling) master = sibling;
  }

  const cost = Number(master.unit_cost);
  if (!Number.isFinite(cost) || cost <= 0) return { unitCostEach: null, reason: "no_cost" };

  const packSize = Math.max(1, Number(master.pack_size) || 1);
  const grain: "pack" | "unit" = hasPpkToken(rawSku) && packSize > 1 ? "pack" : "unit";

  if (grain === "pack") {
    // master.unit_cost is per-pack on PPK masters — divide for per-each.
    return { unitCostEach: cost / packSize, reason: "ok" };
  }
  return { unitCostEach: cost, reason: "ok" };
}

/**
 * Estimate margin for a single open SO row.
 *
 * Mirrors deriveSalesGrainFields → cogs_amount → margin_amount but uses
 * only the data the client has (master.unit_cost / pack_size, no
 * ip_item_avg_cost). Folds in the unit-grain anomaly guard from
 * resolvePerUnitCost (cost > 2 × unit_price → cost / pack_size).
 *
 * Returns margin = 0 when cost can't be resolved — caller still folds
 * the qty + revenue contribution. `costResolved` lets the caller
 * accumulate a coverage counter for the caveat line.
 */
export function estimateSoMargin(
  rawSku: string,
  qty: number,
  totalPrice: number,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): SoMarginResult {
  const initialMaster = firstMaster(rawSku, resolveIds, getMaster);
  if (!initialMaster) {
    return { margin: 0, unitCostEach: null, qtyUnits: Number(qty) || 0, costResolved: false, reason: "no_master" };
  }
  let master = initialMaster;

  // PPK-token routing — re-bind master when we landed on an each-grain
  // row but the raw sku carries a PPK token.
  if (hasPpkToken(rawSku) && (Number(master.pack_size) || 1) <= 1) {
    const sibling = findSiblingPpk(master, resolveIds, getMaster);
    if (sibling) master = sibling;
  }

  const rawCost = Number(master.unit_cost);
  if (!Number.isFinite(rawCost) || rawCost <= 0) {
    return { margin: 0, unitCostEach: null, qtyUnits: Number(qty) || 0, costResolved: false, reason: "no_cost" };
  }

  const packSize = Math.max(1, Number(master.pack_size) || 1);
  const grain: "pack" | "unit" = hasPpkToken(rawSku) && packSize > 1 ? "pack" : "unit";
  const qtyUnits = grain === "pack" ? (Number(qty) || 0) * packSize : (Number(qty) || 0);

  let unitCostEach: number;
  if (grain === "pack") {
    // PPK master cost is per-pack (Xoro convention) — divide for per-each.
    unitCostEach = rawCost / packSize;
  } else {
    // Unit-grain anomaly guard: when master.unit_cost looks like a
    // per-pack figure stored on a pack_size=1 row, divide.
    if (qtyUnits > 0 && Number.isFinite(totalPrice) && totalPrice > 0) {
      const unitPrice = totalPrice / qtyUnits;
      if (unitPrice > 0 && rawCost > unitPrice * 2 && packSize > 1) {
        unitCostEach = rawCost / packSize;
      } else {
        unitCostEach = rawCost;
      }
    } else {
      unitCostEach = rawCost;
    }
  }

  const cogs = qtyUnits * unitCostEach;
  const margin = (Number(totalPrice) || 0) - cogs;
  return { margin, unitCostEach, qtyUnits, costResolved: true, reason: "ok" };
}
