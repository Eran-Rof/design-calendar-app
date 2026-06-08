// Open-SO comp helper — fold forward-looking open sales orders into the
// LY / T3 comp aggregates when the operator's selected period extends
// into the future.
//
// Source: ip_open_sales_orders (populated by ats-supply-sync from the
// ATS Excel SOs blob). Each row carries qty_open + unit_price; cost is
// NOT on the SO so we estimate per-unit via ip_item_avg_cost.avg_cost
// (mirror of the ATS sales-comp SO margin estimator in
// src/ats/salesCompsSoMargin.ts).
//
// Returned shape per sku_id:
//   { qty, costSum, netSum, marginPctNum, txnCount }
// — same units the LY/T3 handlers add into their `agg` slot, so callers
// merge with `+=` after sum'ing the historical sales rows.

import { todayIsoUTC } from "./_today.js";

/**
 * @param admin       supabase service-role client
 * @param skuIds      uuid[] — ip_item_master.id list
 * @param windowFrom  ISO date string (inclusive)
 * @param windowTo    ISO date string (inclusive)
 * @returns {Promise<Map<string, {qty,costSum,netSum,marginPctNum,txnCount}>>}
 *          keyed by sku_id
 */
export async function fetchOpenSoComp(admin, skuIds, windowFrom, windowTo) {
  const out = new Map();
  if (!Array.isArray(skuIds) || skuIds.length === 0) return out;

  // Auto-skip when the window is entirely historical — open SOs by
  // definition haven't shipped yet, so they only matter for windows
  // that include `today` or later.
  const today = todayIsoUTC();
  if (windowTo < today) return out;

  // 1. Pull open SOs whose ship_date (or fallback cancel_date) lands in
  //    the window. qty_open > 0 filters out fully-shipped lines.
  // Use ship_date as the primary timeline; SOs without ship_date are
  // included if the cancel_date falls in window (same fallback the
  // grid Avail-to-Ship uses).
  const { data: sosByShip, error: shipErr } = await admin
    .from("ip_open_sales_orders")
    .select("sku_id, ship_date, cancel_date, qty_open, unit_price")
    .in("sku_id", skuIds)
    .gt("qty_open", 0)
    .gte("ship_date", windowFrom)
    .lte("ship_date", windowTo)
    .range(0, 99999);
  if (shipErr) throw new Error(`open_sos ship_date query: ${shipErr.message}`);

  // SOs with NULL ship_date — fall back to cancel_date.
  const { data: sosByCancel, error: cancelErr } = await admin
    .from("ip_open_sales_orders")
    .select("sku_id, ship_date, cancel_date, qty_open, unit_price")
    .in("sku_id", skuIds)
    .gt("qty_open", 0)
    .is("ship_date", null)
    .gte("cancel_date", windowFrom)
    .lte("cancel_date", windowTo)
    .range(0, 99999);
  if (cancelErr) throw new Error(`open_sos cancel_date query: ${cancelErr.message}`);

  const sos = [...(sosByShip || []), ...(sosByCancel || [])];
  if (sos.length === 0) return out;

  // 2. Cost lookup via ip_item_master → sku_code → ip_item_avg_cost.
  //    sales_history uses sku_id directly; SOs do too but cost source
  //    is the SKU's avg_cost. Bulk-fetch via item_master to bridge.
  const { data: masterRows } = await admin
    .from("ip_item_master")
    .select("id, sku_code")
    .in("id", skuIds)
    .range(0, 9999);
  const skuCodeById = new Map((masterRows || []).map((r) => [r.id, r.sku_code]));
  const skuCodes = Array.from(new Set([...skuCodeById.values()].filter(Boolean)));

  const costBySkuCode = new Map();
  if (skuCodes.length > 0) {
    const { data: costRows } = await admin
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", skuCodes)
      .range(0, 99999);
    for (const r of costRows || []) {
      if (typeof r.avg_cost === "number") costBySkuCode.set(r.sku_code, r.avg_cost);
    }
  }

  // 3. Aggregate per sku.
  for (const r of sos) {
    const skuId = r.sku_id;
    const qty = Number(r.qty_open) || 0;
    if (qty <= 0) continue;
    const unitPrice = r.unit_price != null ? Number(r.unit_price) : 0;
    const skuCode = skuCodeById.get(skuId);
    const avgCost = skuCode ? (costBySkuCode.get(skuCode) || 0) : 0;
    const net = qty * unitPrice;
    const cost = qty * avgCost;
    const margin = net - cost;
    const marginPct = net > 0 ? (margin / net) : 0; // fraction (0.247 = 24.7%) — matches ip_sales_history_wholesale.margin_pct scale

    const slot = out.get(skuId) || { qty: 0, costSum: 0, netSum: 0, marginPctNum: 0, txnCount: 0 };
    slot.qty += qty;
    slot.costSum += cost;
    slot.netSum += net;
    if (net > 0) slot.marginPctNum += net * marginPct;
    slot.txnCount += 1;
    out.set(skuId, slot);
  }

  return out;
}
