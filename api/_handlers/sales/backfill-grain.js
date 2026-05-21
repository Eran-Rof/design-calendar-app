// POST /api/sales/backfill-grain — retroactive pack-priced-as-unit fix.
//
// Walks ip_sales_history_wholesale for rows that were ingested before
// the PPK-token routing landed (i.e. sale priced like a pack but the
// row points at the each-grain master). For each row that finds a PPK
// sibling in master AND has an ip_item_avg_cost row for that sibling,
// re-points sku_id to the PPK master and recomputes qty_units / cogs /
// margin using avg_cost as the per-pack cost.
//
// Body params (JSON):
//   { apply: bool=false, since: "YYYY-MM-DD"? }
// Defaults to dry-run. Pass apply:true to write. `since` narrows the
// txn_date range; omit to scan everything.
//
//   curl -X POST https://design-calendar-app.vercel.app/api/sales/backfill-grain \
//     -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//     -H "Content-Type: application/json" \
//     -d '{"apply": false, "since": "2025-01-01"}'

import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";
import {
  deriveSalesGrainFields,
  findSiblingPpkMaster,
  SUSPICIOUS_PRICE_RATIO,
} from "../../_lib/sales-grain.js";

export const config = { api: { bodyParser: true }, maxDuration: 300 };

const RATE_LIMIT = { limit: 12, windowMs: 60 * 60 * 1000 };
const CHUNK = 500;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const tok = String(req.headers.authorization || "").slice(-8);
  const rl = rateLimit(`backfill-grain:${tok}`, RATE_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retry_after_s));
    return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });
  }
  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "Supabase not configured" });
  const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const apply = body.apply === true;
  const since = typeof body.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.since)
    ? body.since
    : null;

  const counts = {
    apply,
    since,
    suspect_rows: 0,
    reclassified: 0,
    skipped_no_sibling: 0,
    skipped_no_avg_cost: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  // ── Step 1: pull suspect rows ─────────────────────────────────────────
  // pack_size = 1 (each-grain master) + master.unit_cost > 0 + sale
  // priced at >= SUSPICIOUS_PRICE_RATIO × unit_cost.
  // Ecom rows are always eaches — exclude two ways up front so the
  // natural 5-6× retail markup doesn't get flagged as pack-priced-
  // as-unit:
  //   1. Channel name not containing "Ecom" (the explicit signal)
  //   2. Customer name not containing "shopify" (belt-and-suspenders
  //      for Shopify variants that didn't get routed to PT ECOM)
  const wholesaleChannelIds = [];
  {
    const { data, error } = await admin
      .from("ip_channel_master")
      .select("id, name")
      .not("name", "ilike", "%Ecom%");
    if (error) return res.status(500).json({ error: "channel fetch", details: error.message });
    for (const r of data ?? []) wholesaleChannelIds.push(r.id);
  }
  const shopifyCustomerIds = new Set();
  {
    const { data, error } = await admin
      .from("ip_customer_master")
      .select("id")
      .ilike("name", "%shopify%");
    if (error) return res.status(500).json({ error: "shopify cust fetch", details: error.message });
    for (const r of data ?? []) shopifyCustomerIds.add(r.id);
  }
  let suspect = null;
  {
    let query = admin
      .from("ip_sales_history_wholesale")
      .select("id, sku_id, customer_id, qty, unit_price, gross_amount, net_amount, txn_date, invoice_number")
      .in("channel_id", wholesaleChannelIds)
      .limit(20000);
    if (since) query = query.gte("txn_date", since);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: "suspect fetch", details: error.message });
    suspect = (data ?? []).filter(r => !shopifyCustomerIds.has(r.customer_id));
  }

  // Pull all referenced masters in one round-trip.
  const skuIds = [...new Set(suspect.map(s => s.sku_id).filter(Boolean))];
  const mastersById = new Map();
  for (let i = 0; i < skuIds.length; i += CHUNK) {
    const chunk = skuIds.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code, style_code, pack_size, unit_cost")
      .in("id", chunk);
    if (error) { counts.errors.push(`master fetch: ${error.message}`); continue; }
    for (const r of data ?? []) mastersById.set(r.id, r);
  }

  // Filter to actual suspects.
  const actualSuspects = suspect.filter(s => {
    const m = mastersById.get(s.sku_id);
    if (!m) return false;
    if (Number(m.pack_size) > 1) return false;
    const cost = Number(m.unit_cost) || 0;
    if (cost <= 0) return false;
    const price = Number(s.unit_price) || 0;
    return price >= cost * SUSPICIOUS_PRICE_RATIO;
  });
  counts.suspect_rows = actualSuspects.length;

  if (actualSuspects.length === 0) return res.status(200).json(counts);

  // Pull every sibling-PPK master candidate in one round-trip. Cover
  // both naming conventions ({style}PPK{suffix}, {style}-PPK{suffix})
  // and the mis-tagged-style_code fallback so findSiblingPpkMaster can
  // resolve cleanly off masterByCode.
  const siblingSet = new Set();
  for (const id of skuIds) {
    const m = mastersById.get(id);
    if (!m?.style_code) continue;
    const variant = m.sku_code.slice(m.style_code.length);
    siblingSet.add(`${m.style_code}PPK${variant}`);
    siblingSet.add(`${m.style_code}-PPK${variant}`);
    const last = m.sku_code.lastIndexOf("-");
    if (last > 0) {
      const prefix = m.sku_code.slice(0, last);
      const color  = m.sku_code.slice(last);
      const trueStyle = prefix.replace(/-?PPK\d*$/i, "");
      if (trueStyle && trueStyle !== m.style_code) {
        siblingSet.add(`${trueStyle}PPK${color}`);
        siblingSet.add(`${trueStyle}-PPK${color}`);
      }
    }
  }
  const siblingList = [...siblingSet];
  const masterByCode = new Map();
  for (const m of mastersById.values()) masterByCode.set(m.sku_code, m);
  for (let i = 0; i < siblingList.length; i += CHUNK) {
    const chunk = siblingList.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code, style_code, pack_size, unit_cost")
      .in("sku_code", chunk);
    if (error) { counts.errors.push(`sibling fetch: ${error.message}`); continue; }
    for (const r of data ?? []) {
      mastersById.set(r.id, r);
      masterByCode.set(r.sku_code, r);
    }
  }

  // ── Step 2: resolve which suspects route to a PPK sibling. Collect
  // the PPK sku_codes so we can batch-fetch avg_cost for them.
  const plan = [];
  for (const s of actualSuspects) {
    const unitMaster = mastersById.get(s.sku_id);
    const sibling = findSiblingPpkMaster(unitMaster, masterByCode);
    if (!sibling) { counts.skipped_no_sibling += 1; continue; }
    plan.push({ row: s, unitMaster, sibling });
  }
  counts.reclassified = plan.length;

  // ── Step 3: avg_cost lookup for the sibling skus.
  const ppkCodes = [...new Set(plan.map(p => p.sibling.sku_code))];
  const avgCostByCode = new Map();
  for (let i = 0; i < ppkCodes.length; i += CHUNK) {
    const chunk = ppkCodes.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", chunk);
    if (error) { counts.errors.push(`avg cost fetch: ${error.message}`); continue; }
    for (const r of data ?? []) {
      const v = Number(r.avg_cost);
      if (Number.isFinite(v) && v > 0) avgCostByCode.set(r.sku_code, v);
    }
  }

  // ── Step 4: derive new grain fields per row.
  const updates = [];
  for (const p of plan) {
    const avgCost = avgCostByCode.get(p.sibling.sku_code);
    // Allow no-avg-cost rows to fall through to the master fallback so
    // the backfill still corrects qty_units / cogs from master.unit_cost.
    // Operators can spot pure-master-fallback rows via the per-row
    // unit_cost_at_sale matching master / pack_size exactly.
    if (avgCost == null) counts.skipped_no_avg_cost += 1;
    const grain = deriveSalesGrainFields({
      rawItemNumber: p.sibling.sku_code, // contains "PPK" — inferQtyGrain → 'pack'
      qty: Number(p.row.qty),
      netAmount: Number(p.row.net_amount),
      master: { pack_size: p.sibling.pack_size, unit_cost: p.sibling.unit_cost },
      avgCostPerRawQty: avgCost,
    });
    updates.push({
      id: p.row.id,
      sku_id: p.sibling.id,
      ...grain,
    });
  }

  // Preview-only when apply=false.
  if (!apply) {
    return res.status(200).json({
      ...counts,
      preview: updates.slice(0, 25).map(u => ({
        id: u.id, sku_id: u.sku_id,
        qty_grain: u.qty_grain, qty_units: u.qty_units,
        cogs_amount: u.cogs_amount,
        margin_amount: u.margin_amount,
        margin_pct: u.margin_pct,
      })),
    });
  }

  // ── Step 5: apply updates one row at a time. supabase-js doesn't
  // support batched UPDATE-by-id in a single call, so iterate. 300s
  // function timeout covers comfortably more rows than we'll ever see
  // in one backfill window.
  for (const u of updates) {
    const { error } = await admin
      .from("ip_sales_history_wholesale")
      .update({
        sku_id: u.sku_id,
        qty_grain: u.qty_grain,
        qty_units: u.qty_units,
        unit_cost_at_sale: u.unit_cost_at_sale,
        cogs_amount: u.cogs_amount,
        margin_amount: u.margin_amount,
        margin_pct: u.margin_pct,
      })
      .eq("id", u.id);
    if (error) {
      counts.failed += 1;
      counts.errors.push(`update ${u.id}: ${error.message}`);
    } else {
      counts.updated += 1;
    }
  }

  return res.status(200).json(counts);
}
