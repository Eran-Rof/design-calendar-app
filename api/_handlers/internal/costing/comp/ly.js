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
// PPK explosion: pack-grain rows are EXPLODED to per-unit rather than dropped.
// Both base style ("RYB059430") and PPK-variant style ("RYB059430PPK24") rows
// contribute to the comp after normalisation to per-unit qty / cost / price.
// qty_units (stored at ingest) is used directly; unit_cost_at_sale is already
// per-unit in the DB. comp_grain_warning is false when explosion succeeds
// (field kept for back-compat).
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
import { ppkMultiplier, baseStyle } from "../../../../_lib/prepack.js";

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
  //
  // PPK base-style expansion: a costing line typically carries the BASE style
  // (e.g. "RYB059430") but wholesale sales may be recorded under the PPK
  // variant style ("RYB059430PPK24", "RYB059430PPK"). We want BOTH to
  // contribute. Strategy: for each requested style_code also query rows whose
  // base style (PPK suffix stripped) matches — captured by the ILIKE on
  // style_code prefix + the baseStyle() normalisation in the map build below.
  const baseStyleCodes = [...new Set(styleCodes.map(baseStyle))];
  // Build the full set of style codes to query: original + any PPK variants
  // that share the same base. We use ilike prefix matching per-code below
  // instead of an IN so we can catch "RYB059430PPK24" when only "RYB059430"
  // was requested. For simplicity, fetch all ip_item_master rows whose
  // style_code starts with any of the base codes (the set is small for a
  // costing project, so this is safe).
  let masterRows = [];
  for (let i = 0; i < baseStyleCodes.length; i += 50) {
    const slice = baseStyleCodes.slice(i, i + 50);
    // Fetch all rows whose base style matches (covers both exact and PPK variant).
    for (const bc of slice) {
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
  }

  // skuIdToStyle: maps sku uuid → the REQUESTED style_code (base form)
  // so aggregation slots map back to the caller's key.
  const skuIdToStyle = new Map();
  // skuMasterMeta: maps sku uuid → {color, size, description} for ppkMultiplier
  const skuMasterMeta = new Map();
  for (const row of masterRows) {
    if (!row.style_code) continue;
    const rowBase = baseStyle(row.style_code);
    // Find which requested style_code this row belongs to
    const requestedStyle = styleCodes.find((sc) => baseStyle(sc) === rowBase) || null;
    if (!requestedStyle) continue;
    skuIdToStyle.set(row.id, requestedStyle);
    skuMasterMeta.set(row.id, { color: row.color, size: row.size, description: row.description, style_code: row.style_code });
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
  //    and pack rows — pack rows are now EXPLODED rather than dropped.
  //    NOTE: vendor_id filter is accepted for API parity with the caller but
  //    intentionally NOT applied here — ip_sales_history_wholesale has no
  //    vendor_id column (the operator's selected vendor lives in `vendors`,
  //    the portal AR/AP table, which is unrelated to ip_vendor_master that
  //    ip_item_master FKs to). Comp is by style + color; vendor scoping
  //    would require a vendors->ip_vendor_master crosswalk that doesn't
  //    exist yet. Silently ignored so the handler doesn't 500 the moment
  //    the operator picks a winning quote.
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
  //    unit-grain by resolving the multiplier from the master meta (color, size,
  //    description, style_code of the sku). Unit-grain rows are unchanged (mult=1).
  //    This means BOTH base + PPK variant sales contribute per-unit to the comp.
  //
  //    comp_grain_warning is now false when explosion succeeds (kept for back-compat).
  const agg = new Map(); // style_code → { qty, costSum, marginSum, netSum, marginPctNum, txnCount, sawUnitRow, sawAnyRow }
  for (const sc of styleCodes) {
    agg.set(sc, {
      qty: 0,
      costSum: 0,        // sum of qty_units * unit_cost_at_sale (for weighted unit_cost)
      marginSum: 0,      // sum of margin_amount (already per-unit in the DB)
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

    // Resolve multiplier for this row's SKU using master meta.
    const meta = skuMasterMeta.get(r.sku_id);
    const mult = r.qty_grain === "unit"
      ? 1
      : ppkMultiplier(
          meta?.color ?? null,
          meta?.size ?? null,
          meta?.description ?? null,
          meta?.style_code ?? null,
          null, // sku_code not stored on meta; style_code carries the PPK token for variant rows
        );
    // For pack-grain rows, qty_units = qty × mult; unit_cost and unit_price
    // stored in ip_sales_history_wholesale are already per-unit (set at ingest
    // time by deriveSalesGrainFields → resolvePerUnitCost). So we use qty_units
    // directly when available; otherwise fall back to qty × mult.
    const explodedQty = r.qty_units != null
      ? Number(r.qty_units)
      : (Number(r.qty) || 0) * mult;

    slot.sawUnitRow = true; // explosion always succeeds — no warning needed
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
