// api/internal/costing/comp/t3
//
// POST {
//   style_codes: string[],
//   window?: { from: ISO, to: ISO },     // overrides the default 3-month window
//   color?: string,
//   vendor_id?: string,
// }
//
// Trailing-3-month comp aggregation for a batch of styles. Aggregates
// ip_sales_history_wholesale qty / unit_cost / unit_price / margin over
// the window `today - 3 calendar months` → `today` (unless overridden).
//
// PPK guard (per project_ppk_grain_rule_CANONICAL): we filter to
// `qty_grain = 'unit'` ONLY. Pack-grain rows are silently dropped; styles
// whose entire trailing-3-month history was pack-grain return zero qty +
// the flag `comp_grain_warning: true`.
//
// Response: { [style_code]: {
//   qty, weighted_unit_cost, total_cost, weighted_margin_pct,
//   txn_count, comp_grain_warning?: boolean
// } }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { fetchOpenSoComp } from "./_open-so-helper.js";
import { todayIsoUTC } from "./_today.js";

export const config = { maxDuration: 30 };

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusMonths(iso, months) {
  const dt = new Date(iso + "T00:00:00Z");
  const dom = dt.getUTCDate();
  dt.setUTCDate(1); // pin to day 1 to avoid month-overflow
  dt.setUTCMonth(dt.getUTCMonth() - months);
  // clamp day-of-month back into the target month
  const targetMonth = dt.getUTCMonth();
  const targetYear = dt.getUTCFullYear();
  const monthEnd = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(dom, monthEnd));
  return dt.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const styleCodes = Array.isArray(body?.style_codes)
    ? Array.from(new Set(body.style_codes.filter((s) => typeof s === "string" && s.trim()))).map((s) => s.trim())
    : [];
  if (styleCodes.length === 0) {
    return res.status(400).json({ error: "style_codes (non-empty array) is required" });
  }
  const colorFilter = typeof body?.color === "string" && body.color.trim() ? body.color.trim().toLowerCase() : null;
  const vendorIdFilter = typeof body?.vendor_id === "string" && body.vendor_id.trim() ? body.vendor_id.trim() : null;

  // Allow operator override of the default 3-month window.
  let to, from;
  if (body?.window?.from && body?.window?.to) {
    from = String(body.window.from).slice(0, 10);
    to = String(body.window.to).slice(0, 10);
  } else {
    to = todayIso();
    from = isoMinusMonths(to, 3);
  }

  // 1. Resolve style_code → sku_id via ip_item_master (optional color narrowing).
  let masterQuery = admin
    .from("ip_item_master")
    .select("id, style_code, color")
    .in("style_code", styleCodes)
    .range(0, 9999);
  if (colorFilter) masterQuery = masterQuery.ilike("color", colorFilter);
  const { data: masterRows, error: masterErr } = await masterQuery;
  if (masterErr) return res.status(500).json({ error: masterErr.message });

  const skuIdToStyle = new Map();
  for (const row of masterRows || []) {
    if (!row.style_code) continue;
    skuIdToStyle.set(row.id, row.style_code);
  }
  const allSkuIds = Array.from(skuIdToStyle.keys());

  const out = {};
  for (const sc of styleCodes) {
    out[sc] = {
      qty: 0,
      weighted_unit_cost: null,
      weighted_unit_price: null,
      total_cost: 0,
      weighted_margin_pct: null,
      txn_count: 0,
      window_from: from,
      window_to: to,
    };
  }

  if (allSkuIds.length === 0) {
    return res.status(200).json(out);
  }

  // 2. Bulk-fetch sales rows for those skus in the window (optional vendor filter).
  let salesQuery = admin
    .from("ip_sales_history_wholesale")
    .select("sku_id, qty, qty_grain, qty_units, net_amount, unit_cost_at_sale, margin_amount, margin_pct")
    .in("sku_id", allSkuIds)
    .gte("txn_date", from)
    .lte("txn_date", to)
    .range(0, 99999);
  if (vendorIdFilter) salesQuery = salesQuery.eq("vendor_id", vendorIdFilter);
  const { data: salesRows, error: salesErr } = await salesQuery;
  if (salesErr) return res.status(500).json({ error: salesErr.message });

  // 3. Aggregate per-style with PPK guard.
  const agg = new Map();
  for (const sc of styleCodes) {
    agg.set(sc, {
      qty: 0,
      costSum: 0,
      marginSum: 0,
      netSum: 0,
      marginPctNum: 0,
      txnCount: 0,
      sawUnitRow: false,
      sawAnyRow: false,
    });
  }

  for (const r of salesRows || []) {
    const sc = skuIdToStyle.get(r.sku_id);
    if (!sc) continue;
    const slot = agg.get(sc);
    if (!slot) continue;
    slot.sawAnyRow = true;
    if (r.qty_grain !== "unit") continue; // PPK guard
    slot.sawUnitRow = true;
    const qty = Number(r.qty) || 0;
    const unitCost = r.unit_cost_at_sale != null ? Number(r.unit_cost_at_sale) : null;
    const net = r.net_amount != null ? Number(r.net_amount) : null;
    const margin = r.margin_amount != null ? Number(r.margin_amount) : null;
    const marginPct = r.margin_pct != null ? Number(r.margin_pct) : null;
    slot.qty += qty;
    slot.txnCount += 1;
    if (unitCost != null) slot.costSum += qty * unitCost;
    if (margin != null) slot.marginSum += margin;
    if (net != null && net > 0) {
      slot.netSum += net;
      if (marginPct != null) slot.marginPctNum += net * marginPct;
    }
  }

  // Forward-looking SO addition (same logic as /comp/ly). When the
  // selected period extends to/past today, fold open SOs into the
  // per-style aggregates so the operator sees projected sales.
  if (to >= todayIsoUTC()) {
    try {
      const soBySku = await fetchOpenSoComp(admin, allSkuIds, from, to);
      for (const [skuId, soSlot] of soBySku.entries()) {
        const sc = skuIdToStyle.get(skuId);
        if (!sc) continue;
        const slot = agg.get(sc);
        if (!slot) continue;
        slot.sawAnyRow = true;
        slot.sawUnitRow = true;
        slot.qty += soSlot.qty;
        slot.txnCount += soSlot.txnCount;
        slot.costSum += soSlot.costSum;
        slot.netSum += soSlot.netSum;
        slot.marginPctNum += soSlot.marginPctNum;
        slot.marginSum += soSlot.netSum - soSlot.costSum;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[costing/comp/t3] open-SO fold failed: ${e.message}`);
    }
  }

  for (const sc of styleCodes) {
    const slot = agg.get(sc);
    if (!slot) continue;
    out[sc].qty = slot.qty;
    out[sc].weighted_unit_cost = slot.qty > 0 ? slot.costSum / slot.qty : null;
    out[sc].weighted_unit_price = slot.qty > 0 ? slot.netSum / slot.qty : null;
    out[sc].total_cost = slot.costSum;
    out[sc].weighted_margin_pct = slot.netSum > 0 ? slot.marginPctNum / slot.netSum : null;
    out[sc].txn_count = slot.txnCount;
    if (slot.sawAnyRow && !slot.sawUnitRow) {
      out[sc].comp_grain_warning = true;
    }
  }

  return res.status(200).json(out);
}
