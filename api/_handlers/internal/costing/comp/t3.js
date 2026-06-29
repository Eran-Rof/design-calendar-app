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
// PPK explosion: pack-grain rows are EXPLODED to per-unit rather than dropped.
// Both base style ("RYB059430") and PPK-variant style ("RYB059430PPK24") rows
// contribute after normalisation. qty_units (stored at ingest) is used directly;
// unit_cost_at_sale is already per-unit. comp_grain_warning is false when
// explosion succeeds (field kept for back-compat).
//
// Response: { [style_code]: {
//   qty, weighted_unit_cost, total_cost, weighted_margin_pct,
//   txn_count, comp_grain_warning?: boolean
// } }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { fetchOpenSoComp } from "./_open-so-helper.js";
import { todayIsoUTC } from "./_today.js";
import { ppkMultiplier, baseStyle } from "../../../../_lib/prepack.js";

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
  //    PPK base-style expansion: also fetch PPK-variant rows (e.g. "RYB059430PPK24")
  //    when the requested style is the base ("RYB059430"), so pack-grain sales under
  //    the variant are included after explosion. Uses ILIKE prefix per base style.
  const baseStyleCodes = [...new Set(styleCodes.map(baseStyle))];
  let masterRows = [];
  for (const bc of baseStyleCodes) {
    const safeBase = bc.replace(/[%_]/g, "\\$&");
    let q = admin
      .from("ip_item_master")
      .select("id, style_code, color, size, description")
      .ilike("style_code", `${safeBase}%`)
      .range(0, 9999);
    if (colorFilter) q = q.ilike("color", colorFilter);
    const { data, error: masterErr } = await q;
    if (masterErr) return res.status(500).json({ error: masterErr.message });
    if (data) masterRows.push(...data);
  }

  const skuIdToStyle = new Map();
  const skuMasterMeta = new Map();
  for (const row of masterRows) {
    if (!row.style_code) continue;
    const rowBase = baseStyle(row.style_code);
    const requestedStyle = styleCodes.find((sc) => baseStyle(sc) === rowBase) || null;
    if (!requestedStyle) continue;
    skuIdToStyle.set(row.id, requestedStyle);
    skuMasterMeta.set(row.id, { color: row.color, size: row.size, description: row.description, style_code: row.style_code });
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

  // 2. Bulk-fetch sales rows for those skus in the window.
  //    vendor_id filter accepted for API parity but NOT applied —
  //    ip_sales_history_wholesale has no vendor_id column, and the operator's
  //    selected vendor lives in `vendors` (portal table) with no crosswalk to
  //    ip_vendor_master. See ly.js for the full rationale.
  void vendorIdFilter;
  const salesQuery = admin
    .from("ip_sales_history_wholesale")
    .select("sku_id, qty, qty_grain, qty_units, net_amount, unit_cost_at_sale, margin_amount, margin_pct")
    .in("sku_id", allSkuIds)
    .gte("txn_date", from)
    .lte("txn_date", to)
    .range(0, 99999);
  const { data: salesRows, error: salesErr } = await salesQuery;
  if (salesErr) return res.status(500).json({ error: salesErr.message });

  // 3. Aggregate per-style. PPK explosion: pack-grain rows are converted to
  //    unit-grain using qty_units (authoritative unit qty stored at ingest)
  //    and unit_cost_at_sale (already per-unit in DB). Both base and PPK-variant
  //    SKU rows now contribute. comp_grain_warning stays false when explosion
  //    succeeds (field kept for back-compat).
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

    // Resolve multiplier for pack-grain rows.
    const meta = skuMasterMeta.get(r.sku_id);
    const mult = r.qty_grain === "unit"
      ? 1
      : ppkMultiplier(
          meta?.color ?? null,
          meta?.size ?? null,
          meta?.description ?? null,
          meta?.style_code ?? null,
          null,
        );
    // Use the authoritative qty_units field (set at ingest) when available.
    const explodedQty = r.qty_units != null
      ? Number(r.qty_units)
      : (Number(r.qty) || 0) * mult;

    // Exclude SINGLE-UNIT retail/sample sales (per-unit qty ≤ 1) from the
    // WHOLESALE comp — same rule as the LY comp (operator decision). Keyed on the
    // exploded per-unit qty so a 1-pack PPK sale (e.g. 24 units) is kept. Done
    // before marking the row "seen" so a singles-only color reads as "no comp".
    if (explodedQty <= 1) continue;

    slot.sawAnyRow = true;
    slot.sawUnitRow = true; // explosion always succeeds
    const unitCost = r.unit_cost_at_sale != null ? Number(r.unit_cost_at_sale) : null;
    const net = r.net_amount != null ? Number(r.net_amount) : null;
    const margin = r.margin_amount != null ? Number(r.margin_amount) : null;
    const marginPct = r.margin_pct != null ? Number(r.margin_pct) : null;
    slot.qty += explodedQty;
    slot.txnCount += 1;
    if (unitCost != null) slot.costSum += explodedQty * unitCost;
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
