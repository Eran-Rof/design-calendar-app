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
// Cost chain (mirrors ATS.tsx:970-995 — the grid's own marginDollars
// useMemo — narrowed to the modal's TY window for the PO fallback):
//
//   1. Snapshot avgCost: avgCostBySku.get(rawSku). The inventory
//      snapshot's stored per-each average cost (ATSSkuData.avgCost) is
//      the authoritative source — already-applied unit cost from the
//      latest receiving/invoice events.
//   2. PO weighted average across IN-WINDOW open POs sharing the same
//      style as the SO's resolved master. Pre-built once by the caller
//      via poWeightedAvgByStyle (key = master.style_code). Filtered to
//      POs whose Expected-Delivery-Date date falls inside the modal's
//      TY window AND whose style passes the modal's style filter.
//      Style-keyed (not SKU-keyed) so a new style with multiple size /
//      color SKUs gets PO coverage even when only one variant has a
//      live PO. When the receive-date field is unavailable, the caller
//      can hand in a date-unfiltered map — the estimator doesn't know
//      the difference.
//   3. No further fallback. master.unit_cost is intentionally NOT
//      consulted — that source was dropped after PR #287 found that
//      master cost is frequently stale or absent on new styles where
//      the SO commitments live. When neither chain step yields a
//      positive cost the row is marked "no_cost" and counted in the
//      caveat line below the totals.
//
// Pack-grain semantics (unchanged from the previous estimator and
// kept in lockstep with sales-grain.js / resolvePerUnitCost):
//
//   - PPK token in rawSku AND resolved master pack_size > 1 → grain =
//     "pack". qtyUnits = qty × pack_size. The cost from steps 1 / 2 is
//     treated as PER-PACK on the PPK master, so divide by pack_size
//     for per-each cost. (Snapshot avgCost on a PPK SKU is the
//     per-pack avg from the inventory snapshot; PO unitCost on a PPK
//     master is per-pack since Xoro records cost at the master's
//     grain.)
//   - PPK token in rawSku but master is each-grain (pack_size = 1) →
//     PPK-sibling routing finds the pack-grain sibling and uses its
//     style + pack_size. Cost is still resolved against the ORIGINAL
//     raw sku (snapshot path keys on rawSku); the style-keyed PO map
//     uses the sibling's style for broader PO coverage.
//   - Otherwise grain = "unit" and cost is per-each as-is.
//
// Failure modes (return null + reason for the caveat-count UI):
//
//   - "no_master": no item-master record resolves at all (sku unknown
//     or cache not loaded). Margin contribution stays 0 — caller still
//     folds qty + revenue. Style resolution is required for the PO
//     fallback chain so any sku that doesn't resolve a master returns
//     this reason even if the snapshot map happens to have an entry.
//   - "no_cost": master resolved but neither snapshot avgCost nor an
//     in-window PO weighted avg yielded a positive value.

import type { ItemMasterRecord } from "./itemMasterLookup";

export type SoCostReason = "ok" | "no_master" | "no_cost";
export type SoCostSource = "snapshot_avg" | "po_in_window" | "none";

export interface SoCostInputs {
  resolveIds: (sku: string) => string[];
  getMaster: (id: string) => ItemMasterRecord | null;
  /** Per-each snapshot avgCost keyed by rawSku — mirrors
   *  ATSSkuData.avgCost. The ATS grid's canonical cost chain
   *  (ATS.tsx:970-995) keys on the SO row's sku directly, so we do
   *  the same here. Pack-grain divisor is applied downstream when
   *  the resolved master is PPK + the raw sku carries a PPK token. */
  avgCostBySku: Map<string, number>;
  /** Weighted-avg PO unitCost keyed by master.style_code, built
   *  ONCE by the modal across open POs that (a) have a receive date
   *  inside the TY window AND (b) whose resolved style passes the
   *  modal's style filter AND (c) have unitCost > 0. Weighted avg
   *  per style = Σ(qty × unitCost) / Σ(qty). When excelData.pos
   *  lacks a usable receive date the caller's recipe degrades to
   *  "all open POs of matching styles" rather than an empty map. */
  poWeightedAvgByStyle: Map<string, number>;
}

export interface SoUnitCostResult {
  /** Per-each cost in dollars. null when no usable cost is available. */
  unitCostEach: number | null;
  /** Where the cost came from — used in unit tests + future telemetry. */
  source: SoCostSource;
  reason: SoCostReason;
}

export interface SoMarginResult {
  /** Estimated margin in dollars. 0 when cost couldn't be resolved. */
  margin: number;
  /** Per-each cost actually used (null when not resolved). Exposed for
   *  callers that want to log / accumulate average cost. */
  unitCostEach: number | null;
  /** Where the cost came from — mirrors SoUnitCostResult.source. */
  source: SoCostSource;
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

/** Walk the snapshot-avg → PO-weighted-avg chain for the given raw sku
 *  and the resolved style. Returns the first positive cost found and a
 *  source tag. Pure helper — no pack-grain divisor applied here; the
 *  caller divides by pack_size when grain = "pack". */
function resolveRawCost(
  rawSku: string,
  styleForPo: string | null,
  inputs: SoCostInputs,
): { rawCost: number; source: SoCostSource } {
  const snap = inputs.avgCostBySku.get(rawSku);
  if (Number.isFinite(snap) && snap !== undefined && snap > 0) {
    return { rawCost: snap, source: "snapshot_avg" };
  }
  if (styleForPo) {
    const po = inputs.poWeightedAvgByStyle.get(styleForPo);
    if (Number.isFinite(po) && po !== undefined && po > 0) {
      return { rawCost: po, source: "po_in_window" };
    }
  }
  return { rawCost: 0, source: "none" };
}

/**
 * Estimate per-each cost for an open SO row.
 *
 * Returns `{ unitCostEach, source, reason }`:
 *   - `unitCostEach`: dollars per each (multiply by qty_units for COGS).
 *     null when no usable cost was found.
 *   - `source`: which step of the chain produced the cost.
 *   - `reason`: "ok" when a cost was resolved, "no_master" when the sku
 *     doesn't resolve at all, "no_cost" when neither the snapshot map
 *     nor the in-window PO weighted avg yielded a positive value.
 *
 * The function is pure — takes the cache lookups + cost maps as
 * dependencies so the test suite can inject synthetic data without
 * touching the module-level singletons in itemMasterLookup.ts.
 */
export function estimateSoUnitCost(rawSku: string, inputs: SoCostInputs): SoUnitCostResult {
  let master = firstMaster(rawSku, inputs.resolveIds, inputs.getMaster);
  if (!master) return { unitCostEach: null, source: "none", reason: "no_master" };

  // PPK-token routing (Pass 2a-pre): when the raw sku carries a PPK
  // token but we landed on an each-grain master, swap to the sibling
  // PPK master so pack_size is pack-grain.
  if (hasPpkToken(rawSku) && (Number(master.pack_size) || 1) <= 1) {
    const sibling = findSiblingPpk(master, inputs.resolveIds, inputs.getMaster);
    if (sibling) master = sibling;
  }

  const styleForPo = master.style_code ?? null;
  const { rawCost, source } = resolveRawCost(rawSku, styleForPo, inputs);
  if (rawCost <= 0) return { unitCostEach: null, source: "none", reason: "no_cost" };

  const packSize = Math.max(1, Number(master.pack_size) || 1);
  const grain: "pack" | "unit" = hasPpkToken(rawSku) && packSize > 1 ? "pack" : "unit";

  // On a PPK master, both the snapshot avgCost (Xoro inventory grain)
  // and the PO unitCost (Xoro PO grain) are recorded per-pack. Divide
  // by pack_size for the per-each figure that pairs with qtyUnits.
  if (grain === "pack") {
    return { unitCostEach: rawCost / packSize, source, reason: "ok" };
  }
  return { unitCostEach: rawCost, source, reason: "ok" };
}

/**
 * Estimate margin for a single open SO row.
 *
 * Returns `{ margin, unitCostEach, source, qtyUnits, costResolved,
 * reason }`. Margin = totalPrice − qtyUnits × unitCostEach. When cost
 * can't be resolved, margin = 0 and `costResolved` = false — the
 * caller still folds qty + revenue, and the caveat counter surfaces
 * the unresolved row to the operator.
 */
export function estimateSoMargin(
  rawSku: string,
  qty: number,
  totalPrice: number,
  inputs: SoCostInputs,
): SoMarginResult {
  const initialMaster = firstMaster(rawSku, inputs.resolveIds, inputs.getMaster);
  if (!initialMaster) {
    return { margin: 0, unitCostEach: null, source: "none", qtyUnits: Number(qty) || 0, costResolved: false, reason: "no_master" };
  }
  let master = initialMaster;

  // PPK-token routing — re-bind master when we landed on an each-grain
  // row but the raw sku carries a PPK token.
  if (hasPpkToken(rawSku) && (Number(master.pack_size) || 1) <= 1) {
    const sibling = findSiblingPpk(master, inputs.resolveIds, inputs.getMaster);
    if (sibling) master = sibling;
  }

  const styleForPo = master.style_code ?? null;
  const { rawCost, source } = resolveRawCost(rawSku, styleForPo, inputs);

  const packSize = Math.max(1, Number(master.pack_size) || 1);
  const grain: "pack" | "unit" = hasPpkToken(rawSku) && packSize > 1 ? "pack" : "unit";
  const qtyUnits = grain === "pack" ? (Number(qty) || 0) * packSize : (Number(qty) || 0);

  if (rawCost <= 0) {
    return { margin: 0, unitCostEach: null, source: "none", qtyUnits, costResolved: false, reason: "no_cost" };
  }

  // Pack-grain divisor: snapshot avgCost on a PPK SKU is per-pack and
  // PO unitCost on a PPK master is per-pack — both need / pack_size
  // before pairing with qtyUnits (which is already in per-each).
  const unitCostEach = grain === "pack" ? rawCost / packSize : rawCost;
  const cogs = qtyUnits * unitCostEach;
  const margin = (Number(totalPrice) || 0) - cogs;
  return { margin, unitCostEach, source, qtyUnits, costResolved: true, reason: "ok" };
}
