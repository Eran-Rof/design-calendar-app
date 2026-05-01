// Pure aggregation logic for the wholesale planning grid's collapse
// toggles. Extracted from WholesalePlanningGrid.tsx so it can be unit-
// tested without rendering the React tree.
//
// aggregateRows takes a flat list of grid rows and a CollapseModes flag
// set; mergeBucket produces a single rolled-up row from a bucket of
// rows that share the same grouping key.

import type { IpPlanningGridRow } from "../types/wholesale";

export interface CollapseModes {
  customers: boolean;
  colors: boolean;
  category: boolean;
  subCat: boolean;
  // Roll up every style/color owned by one customer into a single
  // line per period — i.e. drop SKU/style/color from the key but
  // keep customer + period. Useful for buyer reviews where
  // per-customer totals matter more than per-style detail.
  customerAllStyles: boolean;
  // Inverse of customerAllStyles: keep the SKU dimension, drop
  // customer. One row per (category, sku, period) summing every
  // customer's demand for that style within the category. Useful
  // for category buyers who plan a style across the whole book.
  allCustomersPerCategory: boolean;
  allCustomersPerSubCat: boolean;
  // Per-style rollup — drops customer AND color. One row per (style,
  // period). Useful when the planner wants total demand for a style
  // across every color and every customer.
  allCustomersPerStyle: boolean;
}

// Aggregate rows by the active collapse modes. Each toggle changes the
// grouping key independently:
//   customers  → drop customer_id from key (sum across customers)
//   colors     → use sku_style instead of sku_id (sum across colors)
//   category   → use group_name; ignore SKU/color/customer
//   subCat     → use sub_category_name; ignore SKU/color/customer
// Category and subCat are mutually exclusive — turning one on clears the
// other (handled at toggle time). When customers/colors are also on, the
// numeric totals are still by period within the chosen rollup.
export function aggregateRows(rows: IpPlanningGridRow[], modes: CollapseModes): IpPlanningGridRow[] {
  const groups = new Map<string, IpPlanningGridRow[]>();
  for (const r of rows) {
    let key: string;
    if (modes.subCat) {
      key = `sub:${r.sub_category_name ?? "—"}:${r.period_code}`;
    } else if (modes.category) {
      key = `cat:${r.group_name ?? "—"}:${r.period_code}`;
    } else if (modes.allCustomersPerStyle) {
      // Style-level: drop customer AND color. Use sku_style if set,
      // else fall back to sku_code as the grouping key.
      key = `acps:${r.sku_style ?? r.sku_code}:${r.period_code}`;
    } else if (modes.allCustomersPerCategory) {
      // Within each category, one row per (style, period) summing every
      // customer. `colors` collapses to style; otherwise color is preserved
      // via sku_id so two color options of the same style don't merge.
      const skuPart = modes.colors ? `style:${r.sku_style ?? r.sku_code}` : `sku:${r.sku_id}`;
      key = `acpc:${r.group_name ?? "—"}:${skuPart}:${r.period_code}`;
    } else if (modes.allCustomersPerSubCat) {
      const skuPart = modes.colors ? `style:${r.sku_style ?? r.sku_code}` : `sku:${r.sku_id}`;
      key = `acpsc:${r.sub_category_name ?? "—"}:${skuPart}:${r.period_code}`;
    } else if (modes.customerAllStyles) {
      // Customer × period only — sums every style this customer
      // bought into one row. Other style/color/SKU fields collapse.
      key = `cust-all:${r.customer_id}:${r.period_code}`;
    } else {
      const skuPart = modes.colors ? `style:${r.sku_style ?? r.sku_code}` : `sku:${r.sku_id}`;
      const custPart = modes.customers ? "all" : r.customer_id;
      key = `${skuPart}:${custPart}:${r.period_code}`;
    }
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); }
    bucket.push(r);
  }
  const out: IpPlanningGridRow[] = [];
  for (const [, bucket] of groups) {
    out.push(bucket.length === 1 ? bucket[0] : mergeBucket(bucket, modes));
  }
  return out;
}

export function mergeBucket(bucket: IpPlanningGridRow[], modes: CollapseModes): IpPlanningGridRow {
  const head = bucket[0];
  const sum = (k: keyof IpPlanningGridRow) =>
    bucket.reduce((a, r) => a + ((r[k] as number) ?? 0), 0);
  const sumNullable = (k: keyof IpPlanningGridRow): number | null => {
    let total = 0;
    let found = false;
    for (const r of bucket) {
      const v = r[k] as number | null | undefined;
      if (v != null) { total += v; found = true; }
    }
    return found ? total : null;
  };
  // Some quantities are SKU-scoped on the row (every row sharing the same
  // (sku, period) carries the same value). Naive sum across a bucket
  // containing N customer-rows for the same SKU multiplies the value by N.
  // Receipts (open POs in period) and Hist Recv (past receipts in period)
  // both have this property — see receiptsBySkuPeriod /
  // historicalReceiptsBySkuPeriod in wholesaleForecastService.
  const sumNullableUniqueSkuPeriod = (k: keyof IpPlanningGridRow): number | null => {
    const seen = new Set<string>();
    let total = 0;
    let found = false;
    for (const r of bucket) {
      const key = `${r.sku_id}:${r.period_start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = r[k] as number | null | undefined;
      if (v != null) { total += v; found = true; }
    }
    return found ? total : null;
  };
  // Unit cost for the rollup row:
  //   1. Weight by planned_buy_qty when buy>0 rows have a cost (best signal
  //      of the dollars actually committed in this rollup).
  //   2. Fall back to plain mean of present unit_costs across the bucket
  //      when no buy>0 row has a cost — otherwise the rollup shows "—"
  //      even though every variant has a perfectly good unit_cost.
  let weightedCost: number | null = null;
  let num = 0, den = 0;
  for (const r of bucket) {
    const q = r.planned_buy_qty ?? 0;
    if (q > 0 && r.unit_cost != null) { num += r.unit_cost * q; den += q; }
  }
  if (den > 0) {
    weightedCost = num / den;
  } else {
    const costs = bucket.map((r) => r.unit_cost).filter((c): c is number => c != null);
    weightedCost = costs.length > 0 ? costs.reduce((a, c) => a + c, 0) / costs.length : null;
  }
  const customerSet = new Set(bucket.map((r) => r.customer_name));
  const styleSet = new Set(bucket.map((r) => r.sku_style ?? r.sku_code));
  const colorSet = new Set(bucket.map((r) => r.sku_color ?? "—"));

  let label = head.customer_name;
  let style: string | null = head.sku_style;
  let color: string | null = head.sku_color;
  let description = head.sku_description;

  if (modes.subCat) {
    label = `(${customerSet.size} cust · ${styleSet.size} styles)`;
    style = head.sub_category_name ?? "(no sub cat)";
    color = null;
    description = `Sub Cat rollup — ${bucket.length} forecast rows`;
  } else if (modes.category) {
    label = `(${customerSet.size} cust · ${styleSet.size} styles)`;
    style = head.group_name ?? "(no category)";
    color = null;
    description = `Category rollup — ${bucket.length} forecast rows`;
  } else if (modes.allCustomersPerCategory) {
    label = `(${customerSet.size} customers)`;
    // Style stays as the head row's style; description tags the category
    // so the row's grouping is obvious without resizing the cat column.
    description = `${head.group_name ?? "(no category)"} · ${bucket.length} forecast rows`;
    if (modes.colors && colorSet.size > 1) color = `(${colorSet.size} colors)`;
  } else if (modes.allCustomersPerSubCat) {
    label = `(${customerSet.size} customers)`;
    description = `${head.sub_category_name ?? "(no sub cat)"} · ${bucket.length} forecast rows`;
    if (modes.colors && colorSet.size > 1) color = `(${colorSet.size} colors)`;
  } else if (modes.allCustomersPerStyle) {
    // Per-style rollup: customer and color both collapsed.
    label = `(${customerSet.size} cust · ${colorSet.size} colors)`;
    style = head.sku_style ?? head.sku_code;
    color = null;
    description = `Style rollup — ${bucket.length} forecast rows`;
  } else if (modes.customerAllStyles) {
    // Single customer + period; sum across every style/color.
    style = `(${styleSet.size} styles)`;
    color = null;
    description = `Customer rollup — ${bucket.length} forecast rows`;
    // customer_name stays as head.customer_name
  } else {
    if (modes.customers && customerSet.size > 1) label = `(${customerSet.size} customers)`;
    if (modes.colors && colorSet.size > 1) color = `(${colorSet.size} colors)`;
  }

  return {
    ...head,
    forecast_id: `agg:${head.forecast_id}:${bucket.length}`,
    is_aggregate: true,
    aggregate_count: bucket.length,
    aggregate_underlying_ids: bucket.map((r) => r.forecast_id),
    customer_id: modes.customers ? "*" : head.customer_id,
    customer_name: label,
    sku_style: style,
    sku_color: color,
    sku_description: description,
    historical_trailing_qty: sum("historical_trailing_qty"),
    system_forecast_qty: sum("system_forecast_qty"),
    buyer_request_qty: sum("buyer_request_qty"),
    override_qty: sum("override_qty"),
    final_forecast_qty: sum("final_forecast_qty"),
    // Aggregate system override metadata is not meaningful at rollup
    // grain — clear the per-row tooltip fields so the merged row
    // doesn't pretend a single user changed the bucket's total.
    system_forecast_qty_original: sum("system_forecast_qty_original"),
    system_forecast_qty_overridden_at: null,
    system_forecast_qty_overridden_by: null,
    ly_reference_qty: sumNullable("ly_reference_qty"),
    on_hand_qty: sumNullableUniqueSkuPeriod("on_hand_qty"),
    on_so_qty: sum("on_so_qty"),
    on_po_qty: sumNullableUniqueSkuPeriod("on_po_qty"),
    receipts_due_qty: sumNullableUniqueSkuPeriod("receipts_due_qty"),
    historical_receipts_qty: sumNullableUniqueSkuPeriod("historical_receipts_qty"),
    available_supply_qty: sumNullableUniqueSkuPeriod("available_supply_qty") ?? 0,
    projected_shortage_qty: sumNullableUniqueSkuPeriod("projected_shortage_qty") ?? 0,
    projected_excess_qty: sumNullableUniqueSkuPeriod("projected_excess_qty") ?? 0,
    planned_buy_qty: sumNullable("planned_buy_qty"),
    unit_cost: weightedCost,
    avg_cost: weightedCost ?? head.avg_cost,
    item_cost: weightedCost ?? head.item_cost,
    unit_cost_override: null,
  };
}
