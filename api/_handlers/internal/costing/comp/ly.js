// api/internal/costing/comp/ly
//
// POST {
//   style_codes: string[],
//   window?: { from: ISO, to: ISO },
//   color?: string,                      // optional case-insensitive filter
//   vendor_id?: string,                  // optional FK filter (vendors.id)
// }
//
// Last-year comp aggregation for a batch of styles. Aggregates
// ip_sales_history_wholesale qty / unit_cost / unit_price / margin over
// the LY window (default: same calendar window 12 months ago —
// `today - 365` → `today`, shifted back one year). Body may override
// with `window.from` + `window.to` (in which case the requested window
// is shifted back 12 months).
//
// PPK guard (per project_ppk_grain_rule_CANONICAL): we filter to
// `qty_grain = 'unit'` ONLY. Pack-grain rows are silently dropped; styles
// whose entire LY history was pack-grain return zero qty + the flag
// `comp_grain_warning: true` so the caller can warn the user that the
// snapshot is empty by design.
//
// Response: { [style_code]: {
//   qty, weighted_unit_cost, total_margin, weighted_margin_pct,
//   txn_count, comp_grain_warning?: boolean
// } }
//
// Single-invocation, designed to run under the 30 s Vercel timeout for a
// few hundred styles (the typical costing project has 5-50 styles, so the
// per-call cost is dominated by the one bulk select against
// ip_sales_history_wholesale).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { fetchOpenSoComp } from "./_open-so-helper.js";
import { todayIsoUTC } from "./_today.js";

export const config = { maxDuration: 30 };

const DEFAULT_WINDOW_DAYS = 365; // a calendar year ending today

function shiftIsoYear(iso, deltaYears) {
  // YYYY-MM-DD → shift the year component, keep month/day. Leap-day edge
  // (Feb 29) snaps back to Feb 28 in non-leap target years.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]) + deltaYears;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const monthDays = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const day = Math.min(d, monthDays[mo - 1]);
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(iso, days) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function defaultLyWindow() {
  // Default LY window = same calendar window as the current trailing year,
  // shifted back 12 months. i.e. from = today-365 days, then both ends are
  // shifted back another 12 months.
  const t = todayIso();
  const from = isoMinusDays(t, DEFAULT_WINDOW_DAYS);
  return { from: shiftIsoYear(from, -1), to: shiftIsoYear(t, -1) };
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

  // Resolve window. If the caller supplied a window, shift each end back 12
  // months (so the LY endpoint compares to "same calendar slice, last year").
  let from, to;
  if (body?.window?.from && body?.window?.to) {
    from = shiftIsoYear(String(body.window.from).slice(0, 10), -1);
    to = shiftIsoYear(String(body.window.to).slice(0, 10), -1);
  } else {
    const w = defaultLyWindow();
    from = w.from;
    to = w.to;
  }

  // 1. Bulk-resolve style_code → sku_id via ip_item_master, optionally
  // narrowed by color (operator may want comp scoped to a specific color
  // when multiple colors exist under the style).
  let masterQuery = admin
    .from("ip_item_master")
    .select("id, style_code, color")
    .in("style_code", styleCodes)
    .range(0, 9999);
  if (colorFilter) masterQuery = masterQuery.ilike("color", colorFilter);
  const { data: masterRows, error: masterErr } = await masterQuery;
  if (masterErr) return res.status(500).json({ error: masterErr.message });

  const skuIdToStyle = new Map();
  const styleSkuCounts = new Map();
  for (const row of masterRows || []) {
    if (!row.style_code) continue;
    skuIdToStyle.set(row.id, row.style_code);
    styleSkuCounts.set(row.style_code, (styleSkuCounts.get(row.style_code) || 0) + 1);
  }
  const allSkuIds = Array.from(skuIdToStyle.keys());

  // Empty-state response: every requested style with zeroed aggregates so
  // the caller can iterate cleanly. comp_grain_warning omitted for styles
  // with no matching ip_item_master rows (different cause from PPK-only).
  const out = {};
  for (const sc of styleCodes) {
    out[sc] = {
      qty: 0,
      weighted_unit_cost: null,
      weighted_unit_price: null,
      total_margin: 0,
      weighted_margin_pct: null,
      txn_count: 0,
      window_from: from,
      window_to: to,
    };
  }

  if (allSkuIds.length === 0) {
    return res.status(200).json(out);
  }

  // 2. Bulk-fetch sales rows for those skus in the window. Pull both unit
  //    and pack rows so we can detect "all-PPK" styles AFTER aggregation.
  //    Optional vendor_id filter narrows to lines purchased through one
  //    vendor (when the operator wants comp for a specific factory).
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

  // 3. Aggregate per-style. PPK guard: only `qty_grain = 'unit'` rows
  //    contribute to qty / cost / margin. Track per-style whether ANY
  //    unit-grain rows existed; if not, set comp_grain_warning.
  const agg = new Map(); // style_code → { qty, costSum, marginSum, netSum, marginPctNum, marginPctDen, txnCount, sawUnitRow, sawAnyRow }
  for (const sc of styleCodes) {
    agg.set(sc, {
      qty: 0,
      costSum: 0,        // sum of qty * unit_cost_at_sale (for weighted unit_cost)
      marginSum: 0,      // sum of margin_amount
      netSum: 0,         // sum of net_amount (for weighted margin_pct denominator)
      marginPctNum: 0,   // sum of net_amount * margin_pct (numerator)
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
    if (r.qty_grain !== "unit") continue; // PPK guard — drop pack rows
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

  // 4. Forward-looking SO addition. When `to >= today` the window
  //    overlaps the future — fold ip_open_sales_orders into the same
  //    per-style aggregates so the operator sees projected sales (with
  //    cost estimated via ip_item_avg_cost). Mirrors the ATS sales-
  //    comps SO margin pattern (src/ats/salesCompsSoMargin.ts).
  if (to >= todayIsoUTC()) {
    try {
      const soBySku = await fetchOpenSoComp(admin, allSkuIds, from, to);
      for (const [skuId, soSlot] of soBySku.entries()) {
        const sc = skuIdToStyle.get(skuId);
        if (!sc) continue;
        const slot = agg.get(sc);
        if (!slot) continue;
        slot.sawAnyRow = true;
        slot.sawUnitRow = true; // open SOs are unit-grain by source
        slot.qty += soSlot.qty;
        slot.txnCount += soSlot.txnCount;
        slot.costSum += soSlot.costSum;
        slot.netSum += soSlot.netSum;
        slot.marginPctNum += soSlot.marginPctNum;
        slot.marginSum += soSlot.netSum - soSlot.costSum;
      }
    } catch (e) {
      // Non-fatal — historical aggregates still return cleanly.
      // eslint-disable-next-line no-console
      console.warn(`[costing/comp/ly] open-SO fold failed: ${e.message}`);
    }
  }

  for (const sc of styleCodes) {
    const slot = agg.get(sc);
    if (!slot) continue;
    out[sc].qty = slot.qty;
    out[sc].weighted_unit_cost = slot.qty > 0 ? slot.costSum / slot.qty : null;
    // Weighted avg sales price = sum(net_amount) / sum(qty). Operator
    // uses this for the LY Sls Prc column + auto margin calc.
    out[sc].weighted_unit_price = slot.qty > 0 ? slot.netSum / slot.qty : null;
    out[sc].total_margin = slot.marginSum;
    out[sc].weighted_margin_pct = slot.netSum > 0 ? slot.marginPctNum / slot.netSum : null;
    out[sc].txn_count = slot.txnCount;
    // PPK-only style: rows existed in the window but every single one was
    // pack-grain. We zero the aggregates above (no unit rows contributed)
    // and flag the caller so the UI can render a "no comp — all PPK" hint.
    if (slot.sawAnyRow && !slot.sawUnitRow) {
      out[sc].comp_grain_warning = true;
    }
  }

  return res.status(200).json(out);
}
