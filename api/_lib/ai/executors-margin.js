// Margin executor for the Ask AI handler.
//
// Single-call margin computation. Fetches shipments + per-SKU avg cost
// + computes COGS / margin $ / margin % server-side, so the AI cannot
// fabricate a margin rate or "estimate from a representative sample"
// when asked margin questions.
//
// Returns coverage stats so the AI can honestly report partial-cost
// situations ("margin computed over 98.7% of revenue; the other 1.3%
// had no cost on file") instead of papering over them.
//
// Lives separately from executors.js per architecture invariant #2.

import { clampDate } from "./utils.js";
import { QUERY_ROW_LIMIT } from "./constants.js";

// Batch size for .in() filters — stays well under PostgREST URL limits.
const BATCH = 100;

// Compute margin: cogs = Σ(qty × per-unit cost), margin_$ = revenue − cogs,
// margin_% = margin_$ / revenue. Pure function — easy to unit-test.
//
// perSkuRevenueQty: Map<sku_id, { qty, revenue }>
// skuIdToCode:      Map<sku_id, sku_code>
// costBySkuCode:    Map<sku_code, avg_cost>
// skuIdToPackSize:  Map<sku_id, pack_size>   (1 if non-prepack)
//
// Pack handling: ip_item_avg_cost.avg_cost is per-pack for prepacks (it
// inherits the Xoro Item Costing Report grain, which itself is pack-level
// for prepacks per the COST RESOLUTION CASCADE in rof-glossary.js).
// Shipments qty is already at the same grain as the cost (both inherit
// Xoro's recorded grain), so cogs = qty × avg_cost works without a
// pack-size multiplier — they cancel.
export function computeMargin(perSkuRevenueQty, skuIdToCode, costBySkuCode, skuIdToPackSize) {
  let totalRevenue = 0;
  let totalCogs = 0;
  let totalQty = 0;
  let revenueCovered = 0;
  let skuCount = 0;
  let skuCountWithCost = 0;
  const perSku = [];
  for (const [skuId, { qty, revenue }] of perSkuRevenueQty.entries()) {
    skuCount += 1;
    totalRevenue += revenue;
    totalQty += qty;
    const skuCode = skuIdToCode.get(skuId);
    const avgCost = skuCode ? costBySkuCode.get(skuCode) : undefined;
    const packSize = Number(skuIdToPackSize.get(skuId) ?? 1) || 1;
    if (avgCost == null) {
      perSku.push({
        sku_id: skuId,
        sku_code: skuCode ?? null,
        qty,
        revenue,
        avg_cost: null,
        cogs: null,
        margin_dollars: null,
        margin_pct: null,
        pack_size: packSize,
        is_prepack: packSize > 1,
        has_cost: false,
      });
      continue;
    }
    skuCountWithCost += 1;
    revenueCovered += revenue;
    const cogs = qty * Number(avgCost);
    totalCogs += cogs;
    const marginDollars = revenue - cogs;
    const marginPct = revenue > 0 ? marginDollars / revenue : null;
    perSku.push({
      sku_id: skuId,
      sku_code: skuCode ?? null,
      qty,
      revenue,
      avg_cost: Number(avgCost),
      cogs,
      margin_dollars: marginDollars,
      margin_pct: marginPct,
      pack_size: packSize,
      is_prepack: packSize > 1,
      has_cost: true,
    });
  }
  perSku.sort((a, b) => b.revenue - a.revenue);
  const coveragePct = totalRevenue > 0 ? revenueCovered / totalRevenue : null;
  return {
    revenue: totalRevenue,
    cogs: totalCogs,
    margin_dollars: revenueCovered - totalCogs,
    margin_pct: revenueCovered > 0 ? (revenueCovered - totalCogs) / revenueCovered : null,
    total_qty: totalQty,
    sku_count: skuCount,
    sku_count_with_cost: skuCountWithCost,
    cost_coverage_pct: coveragePct,
    uncovered_revenue: totalRevenue - revenueCovered,
    per_sku: perSku,
  };
}

// Aggregate shipments by sku_id over a date window, optionally narrowed
// by customer_ids OR sku_ids. Returns Map<sku_id, { qty, revenue }>.
async function aggregateBySkuId(db, { customerIds, skuIds, dateFrom, dateTo }) {
  const perSku = new Map();
  // If we have a sku narrow, batch by sku batches. Otherwise pull all
  // rows in the date window narrowed by customer.
  const skuBatches = (skuIds && skuIds.length > 0)
    ? Array.from({ length: Math.ceil(skuIds.length / BATCH) }, (_, i) => skuIds.slice(i * BATCH, (i + 1) * BATCH))
    : [null];
  for (const batch of skuBatches) {
    let q = db
      .from("ip_sales_history_wholesale")
      .select("sku_id, qty, net_amount")
      .gte("txn_date", dateFrom)
      .lte("txn_date", dateTo)
      .limit(QUERY_ROW_LIMIT);
    if (customerIds && customerIds.length > 0) q = q.in("customer_id", customerIds);
    if (batch) q = q.in("sku_id", batch);
    const { data, error } = await q;
    if (error) return { error: error.message };
    for (const r of (data || [])) {
      if (!r.sku_id) continue;
      const cur = perSku.get(r.sku_id) ?? { qty: 0, revenue: 0 };
      cur.qty     += Number(r.qty || 0);
      cur.revenue += Number(r.net_amount || 0);
      perSku.set(r.sku_id, cur);
    }
  }
  return { perSku };
}

// Resolve style_code / sku_code → sku_id list against ip_item_master.
async function resolveSkuIds(db, { style_code, sku_code }) {
  if (!style_code && !sku_code) return null;
  let q = db.from("ip_item_master").select("id").limit(2000);
  if (style_code) q = q.eq("style_code", style_code);
  if (sku_code)   q = q.eq("sku_code", sku_code);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { ids: (data || []).map(r => r.id) };
}

// Look up sku_code + pack_size for each sku_id in ip_item_master.
async function lookupSkuMetadata(db, skuIds) {
  const skuIdToCode = new Map();
  const skuIdToPack = new Map();
  if (!skuIds || skuIds.length === 0) return { skuIdToCode, skuIdToPack };
  for (let i = 0; i < skuIds.length; i += BATCH) {
    const batch = skuIds.slice(i, i + BATCH);
    const { data, error } = await db
      .from("ip_item_master")
      .select("id, sku_code, pack_size")
      .in("id", batch);
    if (error) return { error: error.message };
    for (const r of (data || [])) {
      if (r.sku_code) skuIdToCode.set(r.id, r.sku_code);
      const ps = Number(r.pack_size || 1);
      skuIdToPack.set(r.id, ps > 0 ? ps : 1);
    }
  }
  return { skuIdToCode, skuIdToPack };
}

// Look up avg_cost for each sku_code in ip_item_avg_cost.
async function lookupCosts(db, skuCodes) {
  const costBySkuCode = new Map();
  if (!skuCodes || skuCodes.length === 0) return costBySkuCode;
  for (let i = 0; i < skuCodes.length; i += BATCH) {
    const batch = skuCodes.slice(i, i + BATCH);
    const { data, error } = await db
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", batch);
    if (error) return { error: error.message };
    for (const r of (data || [])) {
      if (r.sku_code != null && r.avg_cost != null) {
        costBySkuCode.set(r.sku_code, Number(r.avg_cost));
      }
    }
  }
  return costBySkuCode;
}

// query_margin tool — one call returns revenue + cogs + margin $/% +
// coverage. The AI cannot fabricate any of these numbers because the
// tool either returns them from real data or returns an error.
export async function tool_query_margin(db, input) {
  const dateFrom = clampDate(input?.date_from);
  const dateTo   = clampDate(input?.date_to);
  if (!dateFrom || !dateTo) return { error: "date_from and date_to required (YYYY-MM-DD)" };

  const customerIds = Array.isArray(input?.customer_ids) && input.customer_ids.length > 0
    ? input.customer_ids.filter(id => typeof id === "string" && id.length > 0)
    : (input?.customer_id ? [input.customer_id] : null);

  const resolved = await resolveSkuIds(db, input);
  if (resolved?.error) return { error: resolved.error };
  const narrowSkuIds = resolved?.ids ?? null;
  if (narrowSkuIds && narrowSkuIds.length === 0) {
    return {
      window: { from: dateFrom, to: dateTo },
      revenue: 0, cogs: 0, margin_dollars: 0, margin_pct: null,
      total_qty: 0, sku_count: 0, sku_count_with_cost: 0,
      cost_coverage_pct: null, uncovered_revenue: 0,
      per_sku: [],
      note: "No SKUs matched the supplied style_code/sku_code — nothing to compute margin on.",
    };
  }

  const agg = await aggregateBySkuId(db, {
    customerIds, skuIds: narrowSkuIds, dateFrom, dateTo,
  });
  if (agg.error) return { error: agg.error };
  const perSkuRevenueQty = agg.perSku;

  if (perSkuRevenueQty.size === 0) {
    return {
      window: { from: dateFrom, to: dateTo },
      revenue: 0, cogs: 0, margin_dollars: 0, margin_pct: null,
      total_qty: 0, sku_count: 0, sku_count_with_cost: 0,
      cost_coverage_pct: null, uncovered_revenue: 0,
      per_sku: [],
      note: "No shipments in the requested window for the requested customer/style — nothing to compute margin on.",
    };
  }

  const skuIds = Array.from(perSkuRevenueQty.keys());
  const meta = await lookupSkuMetadata(db, skuIds);
  if (meta.error) return { error: meta.error };
  const { skuIdToCode, skuIdToPack } = meta;

  const skuCodes = Array.from(new Set(Array.from(skuIdToCode.values())));
  const costBySkuCode = await lookupCosts(db, skuCodes);
  if (costBySkuCode.error) return { error: costBySkuCode.error };

  const result = computeMargin(perSkuRevenueQty, skuIdToCode, costBySkuCode, skuIdToPack);

  // Cap the per_sku detail at top 20 by revenue — the totals + coverage
  // are authoritative; the per-sku breakdown is for context.
  const fullPerSku = result.per_sku;
  const topPerSku = fullPerSku.slice(0, 20);
  const uncoveredSkus = fullPerSku.filter(s => !s.has_cost).slice(0, 10).map(s => ({
    sku_code: s.sku_code, qty: s.qty, revenue: s.revenue,
  }));

  return {
    window: { from: dateFrom, to: dateTo },
    customer_ids_used: customerIds,
    revenue: result.revenue,
    cogs: result.cogs,
    margin_dollars: result.margin_dollars,
    margin_pct: result.margin_pct,
    total_qty: result.total_qty,
    sku_count: result.sku_count,
    sku_count_with_cost: result.sku_count_with_cost,
    cost_coverage_pct: result.cost_coverage_pct,
    uncovered_revenue: result.uncovered_revenue,
    per_sku_top_20: topPerSku,
    uncovered_skus_sample: uncoveredSkus,
    note:
      result.cost_coverage_pct != null && result.cost_coverage_pct < 1
        ? `Margin computed over ${result.sku_count_with_cost} of ${result.sku_count} skus (${(result.cost_coverage_pct * 100).toFixed(1)}% of revenue). The other $${result.uncovered_revenue.toFixed(2)} had no avg_cost on file — report this coverage figure in the answer, do not invent a cost rate for the uncovered portion.`
        : "Full cost coverage for the requested window.",
  };
}
