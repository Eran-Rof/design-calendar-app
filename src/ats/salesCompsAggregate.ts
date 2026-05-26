// Explode-PPK-aware dimension aggregator for Sales Comps.
//
// Takes a per-SKU raw aggregate map (the same shape SalesCompsModal
// builds in its tableRows useMemo — qty / rev / margin in master's
// native grain) plus the explodePpk toggle, and returns dim-level rows
// that the CompsTable + Excel export can render directly.
//
// Two modes:
//
//   ON (explodePpk = true):
//     * For PPK-grain SKUs, multiply qty by master.pack_size to get
//       eaches. Revenue and margin DO NOT change (already in dollars).
//     * Collapse PPK + each siblings into ONE row per (style stem,
//       color) for the sku dim, or per dim-value for higher dims.
//     * Row label prefers the each-grain sibling's code so the
//       operator reads the row in the grain they expect (eaches).
//
//   OFF (explodePpk = false):
//     * qty stays in master's native grain — no multiplication.
//     * Each dim row may SPLIT into two sub-rows: one tagged "(PPK
//       packs)" and one tagged "(each)" so the operator never reads
//       pack qty + each qty as a single misleading sum.
//     * When only one grain is present for a dim, render as a single
//       row with the grain suffix appended (operator still knows
//       which grain they're looking at).
//
// The totals row split (when mixed grain is present in explode-OFF
// mode) is computed by buildTotalsRowsForExplodeOff below — callers
// render one or two totals rows accordingly.

import type { ItemMasterRecord } from "./itemMasterLookup";
import {
  classifyMasterGrain,
  explodeMultiplier,
  firstMasterFor,
  findEachSibling,
  grainLabelSuffix,
  siblingKeyFor,
  type GetMasterFn,
  type ResolveIdsFn,
  type SkuGrain,
} from "./salesCompsGrain";

/** Raw per-SKU aggregate — what SalesCompsModal builds from
 *  result.t3 + result.ly + result.extraBySkuId + openSoAggregates.
 *  qty is in master's native grain (packs for PPK, eaches for each).
 *  Rev + Mrgn are always in dollars. */
export interface RawSkuAgg {
  sku: string;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
}

/** Dim-level row returned by aggregateExplodeAware. label is what the
 *  CompsTable renders in the leftmost cell; grain is "ppk" or "each"
 *  when explodePpk is OFF and the dim has been split (or there's only
 *  one grain), or "ppk"/"each" reflecting the dominant grain in
 *  explode-ON mode (callers can ignore in that mode). */
export interface DimRow {
  key: string;
  label: string;
  grain: SkuGrain;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
}

export type DimKind = "sku" | "style" | "category" | "sub_category" | "customer" | "gender";

export interface AggregateExplodeAwareArgs {
  raw: RawSkuAgg[];
  dim: DimKind;
  explodePpk: boolean;
  resolveIds: ResolveIdsFn;
  getMaster: GetMasterFn;
  /** Optional per-customer rollup. Required when dim === "customer"
   *  since customer name isn't derivable from the item master. Each
   *  entry is the raw aggregate for one customer (qty in master's
   *  native grain). */
  customerRaw?: Array<{
    customer: string;
    sku: string;
    tyQty: number; tyRev: number; tyMrgn: number;
    lyQty: number; lyRev: number; lyMrgn: number;
  }>;
}

/** Look up the dim-value label for a raw row. Returns the master-
 *  derived dim value (e.g. style code, category name), or null when
 *  the master can't be resolved or carries no value for that dim. */
function dimLabelFor(
  master: ItemMasterRecord | null,
  dim: DimKind,
): string | null {
  if (!master) return null;
  switch (dim) {
    case "sku":          return master.sku_code ?? null;
    case "style":        return master.style_code ?? null;
    case "category":     return master.attributes?.group_name ?? null;
    case "sub_category": return master.attributes?.category_name ?? null;
    case "gender":       return master.attributes?.gender ?? null;
    case "customer":     return null; // handled separately via customerRaw
  }
}

/** When explode is ON, normalize the "style stem" so PPK + each
 *  collapse to the same key. For style dim specifically, the canonical
 *  display key is the each-grain stem (PPK suffix stripped). */
function eachStem(styleCode: string | null): string | null {
  if (!styleCode) return null;
  return styleCode.replace(/-?PPK\d*$/i, "");
}

/**
 * Main entry point. See module doc for behavior.
 *
 * Returns one DimRow per dim value in explode-ON mode, or one-or-two
 * DimRows per dim value in explode-OFF mode (one per grain when mixed).
 */
export function aggregateExplodeAware(args: AggregateExplodeAwareArgs): DimRow[] {
  const { raw, dim, explodePpk, resolveIds, getMaster, customerRaw } = args;

  // Customer dim has its own input shape — handle separately.
  if (dim === "customer") {
    return aggregateCustomerDim(customerRaw ?? [], explodePpk, resolveIds, getMaster);
  }

  // For the SKU dim, the canonical display key is the master's sku_code
  // (or the each-grain sibling's sku_code when explode is ON and a
  // sibling exists). Other dims use the master-derived dim value.

  type Bucket = {
    key: string;
    label: string;
    grain: SkuGrain;
    tyQty: number; tyRev: number; tyMrgn: number;
    lyQty: number; lyRev: number; lyMrgn: number;
  };
  const buckets = new Map<string, Bucket>();
  const ensure = (key: string, label: string, grain: SkuGrain): Bucket => {
    const cur = buckets.get(key);
    if (cur) return cur;
    const fresh: Bucket = { key, label, grain, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
    buckets.set(key, fresh);
    return fresh;
  };

  for (const r of raw) {
    const master = firstMasterFor(r.sku, resolveIds, getMaster);
    const grain = classifyMasterGrain(master);
    const qtyMul = explodePpk ? explodeMultiplier(master) : 1;
    const tyQty = r.tyQty * qtyMul;
    const lyQty = r.lyQty * qtyMul;

    if (explodePpk) {
      // Collapse PPK + each siblings into one row.
      let key: string;
      let label: string;
      if (dim === "sku") {
        // Sibling key collapses both grains under the (stem, color)
        // pair. Display label prefers the each-grain sibling's
        // sku_code when one exists, else the master's own sku_code.
        key = siblingKeyFor(master);
        let displaySku: string | null = null;
        if (master) {
          if (grain === "ppk") {
            const eachSib = findEachSibling(master, resolveIds, getMaster);
            displaySku = eachSib?.sku_code ?? master.sku_code ?? r.sku;
          } else {
            displaySku = master.sku_code ?? r.sku;
          }
        }
        label = displaySku ?? r.sku;
      } else if (dim === "style") {
        // Strip the PPK suffix so PPK + each styles collapse.
        const stem = eachStem(master?.style_code ?? null) ?? `(no ${dim})`;
        key = stem;
        label = stem;
      } else {
        const v = dimLabelFor(master, dim) ?? `(no ${dim})`;
        key = v;
        label = v;
      }
      // Grain on a collapsed row: prefer "each" if any each contributed,
      // else "ppk". This grain field is informational in explode-ON
      // mode — callers don't render two rows there.
      const existing = buckets.get(key);
      const finalGrain: SkuGrain = existing?.grain === "each" ? "each" : grain;
      const bucket = ensure(key, label, finalGrain);
      // Update label if a later sibling resolves a cleaner each-grain code.
      if (dim === "sku" && grain === "each" && master?.sku_code) {
        bucket.label = master.sku_code;
        bucket.grain = "each";
      }
      bucket.tyQty += tyQty;
      bucket.tyRev += r.tyRev;
      bucket.tyMrgn += r.tyMrgn;
      bucket.lyQty += lyQty;
      bucket.lyRev += r.lyRev;
      bucket.lyMrgn += r.lyMrgn;
    } else {
      // Explode OFF: split by grain. Key = `<dim value>::<grain>`.
      let dimValue: string;
      if (dim === "sku") {
        dimValue = master?.sku_code ?? r.sku;
      } else if (dim === "style") {
        // Keep the raw style_code (don't strip PPK) so each grain shows
        // under its own row.
        dimValue = master?.style_code ?? `(no ${dim})`;
      } else {
        dimValue = dimLabelFor(master, dim) ?? `(no ${dim})`;
      }
      const key = `${dimValue}::${grain}`;
      // Label appends the grain suffix; the caller knows mixed-vs-single
      // doesn't change the per-row rendering (always suffixed in
      // explode-OFF mode for clarity). Suffix-with-empty-string when
      // explodePpk is ON keeps the label clean — qty is already in
      // eaches and "(PPK packs)" / "(each)" would be misleading.
      const suffix = grainLabelSuffix(grain, explodePpk);
      const label = suffix ? `${dimValue} ${suffix}` : dimValue;
      const bucket = ensure(key, label, grain);
      bucket.tyQty += tyQty;
      bucket.tyRev += r.tyRev;
      bucket.tyMrgn += r.tyMrgn;
      bucket.lyQty += lyQty;
      bucket.lyRev += r.lyRev;
      bucket.lyMrgn += r.lyMrgn;
    }
  }

  // Sort: by max(tyRev, lyRev) descending, mirroring the existing
  // groupedRowsFor behavior so display order stays stable.
  return [...buckets.values()].sort((a, b) =>
    Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev),
  );
}

/** Customer dim aggregator. Same grain split as the master-derived
 *  dims, but the dim value is the customer name (passed in directly).
 *  In explode-ON mode the per-customer rows merge by customer name; in
 *  explode-OFF mode they split per (customer, grain). */
function aggregateCustomerDim(
  customerRaw: NonNullable<AggregateExplodeAwareArgs["customerRaw"]>,
  explodePpk: boolean,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): DimRow[] {
  type Bucket = DimRow;
  const buckets = new Map<string, Bucket>();
  const ensure = (key: string, label: string, grain: SkuGrain): Bucket => {
    const cur = buckets.get(key);
    if (cur) return cur;
    const fresh: Bucket = { key, label, grain, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
    buckets.set(key, fresh);
    return fresh;
  };

  for (const r of customerRaw) {
    const master = firstMasterFor(r.sku, resolveIds, getMaster);
    const grain = classifyMasterGrain(master);
    const qtyMul = explodePpk ? explodeMultiplier(master) : 1;
    const tyQty = r.tyQty * qtyMul;
    const lyQty = r.lyQty * qtyMul;

    if (explodePpk) {
      const key = r.customer;
      const bucket = ensure(key, r.customer, grain);
      // Mark "each" if any each contribution lands here — informational only.
      if (grain === "each") bucket.grain = "each";
      bucket.tyQty += tyQty;
      bucket.tyRev += r.tyRev;
      bucket.tyMrgn += r.tyMrgn;
      bucket.lyQty += lyQty;
      bucket.lyRev += r.lyRev;
      bucket.lyMrgn += r.lyMrgn;
    } else {
      const key = `${r.customer}::${grain}`;
      const suffix = grainLabelSuffix(grain, explodePpk);
      const label = suffix ? `${r.customer} ${suffix}` : r.customer;
      const bucket = ensure(key, label, grain);
      bucket.tyQty += tyQty;
      bucket.tyRev += r.tyRev;
      bucket.tyMrgn += r.tyMrgn;
      bucket.lyQty += lyQty;
      bucket.lyRev += r.lyRev;
      bucket.lyMrgn += r.lyMrgn;
    }
  }

  return [...buckets.values()].sort((a, b) =>
    Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev),
  );
}

/** Computes totals from a DimRow[] result. In explode-OFF mode where
 *  mixed grain is present, callers should render TWO totals rows
 *  (one per grain) to avoid summing packs + eaches into a misleading
 *  number; in single-grain mode (or explode ON), one row is enough.
 *
 *  Returns `{ ppk, each, hasMixed }`. When hasMixed is true, both ppk
 *  and each carry a totals object; otherwise the single grain's
 *  totals is the only meaningful one. */
export interface GrainTotal {
  tyQty: number; tyRev: number; tyMrgn: number; tyCogs: number;
  lyQty: number; lyRev: number; lyMrgn: number; lyCogs: number;
}
export interface DimTotals {
  ppk: GrainTotal;
  each: GrainTotal;
  /** True when both ppk and each contributed at least one row. Callers
   *  in explode-OFF mode render two totals rows when true. */
  hasMixed: boolean;
  /** Combined totals — used by callers in explode-ON mode where the
   *  qty math is already in eaches and a single row is correct. */
  combined: GrainTotal;
}

const ZERO_TOTAL = (): GrainTotal => ({
  tyQty: 0, tyRev: 0, tyMrgn: 0, tyCogs: 0,
  lyQty: 0, lyRev: 0, lyMrgn: 0, lyCogs: 0,
});

export function totalsForDimRows(rows: DimRow[], explodePpk: boolean = false): DimTotals {
  const ppk = ZERO_TOTAL();
  const each = ZERO_TOTAL();
  const combined = ZERO_TOTAL();
  let sawPpk = false, sawEach = false;
  for (const r of rows) {
    const t = r.grain === "ppk" ? ppk : each;
    if (r.grain === "ppk") sawPpk = true; else sawEach = true;
    t.tyQty += r.tyQty; t.tyRev += r.tyRev; t.tyMrgn += r.tyMrgn;
    t.lyQty += r.lyQty; t.lyRev += r.lyRev; t.lyMrgn += r.lyMrgn;
    combined.tyQty += r.tyQty; combined.tyRev += r.tyRev; combined.tyMrgn += r.tyMrgn;
    combined.lyQty += r.lyQty; combined.lyRev += r.lyRev; combined.lyMrgn += r.lyMrgn;
  }
  ppk.tyCogs = ppk.tyRev - ppk.tyMrgn;
  ppk.lyCogs = ppk.lyRev - ppk.lyMrgn;
  each.tyCogs = each.tyRev - each.tyMrgn;
  each.lyCogs = each.lyRev - each.lyMrgn;
  combined.tyCogs = combined.tyRev - combined.tyMrgn;
  combined.lyCogs = combined.lyRev - combined.lyMrgn;
  // With Explode ON, every qty is already in eaches (PPK × pack_size
  // applied upstream) and the combined sum IS the correct grand total.
  // Force hasMixed=false so callers emit ONE combined TOTAL row even
  // when the dim happens to span both grains (e.g. Sub-Category, where
  // PPK styles and each styles live under different sub-cats and the
  // sibling-collapse can't bridge the boundary).
  const hasMixed = explodePpk ? false : (sawPpk && sawEach);
  return { ppk, each, combined, hasMixed };
}
