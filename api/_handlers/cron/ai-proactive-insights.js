// api/cron/ai-proactive-insights
//
// Daily proactive-insight generator for the Ask AI panel (Tier 3K).
// Pulls aggregated sales data, runs hard-coded rules from
// api/_lib/ai/proactive-rules.js, and upserts insight rows into
// ip_ai_proactive_insights. Dedupe key (rule + subject + week) makes
// re-runs the same day idempotent.
//
// Auth: Vercel cron sends Authorization: Bearer ${CRON_SECRET}.
// If CRON_SECRET is unset, the endpoint is open (manual dry-runs).

import { createClient } from "@supabase/supabase-js";
import {
  detectCustomerChurnSignals,
  detectStyleRunaways,
  detectStyleDeclines,
} from "../../_lib/ai/proactive-rules.js";
import { QUERY_ROW_LIMIT } from "../../_lib/ai/constants.js";

export const config = { maxDuration: 60 };

function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dateRange(daysBack, endDate = new Date()) {
  const to = isoDate(endDate);
  const from = isoDate(new Date(endDate.getTime() - daysBack * 86400000));
  return { from, to };
}

// Pull customer-level revenue between two dates → Map<id, revenue>.
async function customerRevenue(db, dateFrom, dateTo) {
  const { data, error } = await db
    .from("ip_sales_history_wholesale")
    .select("customer_id, net_amount")
    .gte("txn_date", dateFrom)
    .lte("txn_date", dateTo)
    .limit(QUERY_ROW_LIMIT);
  if (error) return { error: error.message, byCustomer: new Map() };
  const byCustomer = new Map();
  for (const r of (data || [])) {
    if (!r.customer_id) continue;
    const cur = byCustomer.get(r.customer_id) || 0;
    byCustomer.set(r.customer_id, cur + Number(r.net_amount || 0));
  }
  return { byCustomer };
}

// Pull style-level qty between two dates → Map<style_code, qty>.
// Requires a sku_id → style_code lookup per result.
async function styleQty(db, dateFrom, dateTo) {
  const { data, error } = await db
    .from("ip_sales_history_wholesale")
    .select("sku_id, qty")
    .gte("txn_date", dateFrom)
    .lte("txn_date", dateTo)
    .limit(QUERY_ROW_LIMIT);
  if (error) return { error: error.message, byStyle: new Map() };
  const skuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  if (skuIds.length === 0) return { byStyle: new Map() };

  const skuToStyle = new Map();
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, style_code")
      .in("id", batch);
    for (const m of (masters || [])) if (m.style_code) skuToStyle.set(m.id, m.style_code);
  }

  const byStyle = new Map();
  for (const r of (data || [])) {
    const style = skuToStyle.get(r.sku_id);
    if (!style) continue;
    const qty = Number(r.qty || 0);
    byStyle.set(style, (byStyle.get(style) || 0) + qty);
  }
  return { byStyle };
}

// Open-PO qty per style — joins sku_id → style_code.
async function openPoQtyByStyle(db) {
  const { data, error } = await db
    .from("ip_open_purchase_orders")
    .select("sku_id, qty_open")
    .gt("qty_open", 0)
    .limit(QUERY_ROW_LIMIT);
  if (error) return { error: error.message, byStyle: new Map() };
  const skuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  if (skuIds.length === 0) return { byStyle: new Map() };

  const skuToStyle = new Map();
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, style_code")
      .in("id", batch);
    for (const m of (masters || [])) if (m.style_code) skuToStyle.set(m.id, m.style_code);
  }

  const byStyle = new Map();
  for (const r of (data || [])) {
    const style = skuToStyle.get(r.sku_id);
    if (!style) continue;
    byStyle.set(style, (byStyle.get(style) || 0) + Number(r.qty_open || 0));
  }
  return { byStyle };
}

async function attachCustomerNames(db, byCustomer) {
  const ids = Array.from(byCustomer.keys());
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data } = await db
      .from("ip_customer_master")
      .select("id, name")
      .in("id", batch);
    for (const c of (data || [])) {
      const cur = byCustomer.get(c.id);
      if (cur) cur.name = c.name;
    }
  }
  return byCustomer;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const now = new Date();
  const t7  = dateRange(7,  now);
  const t30 = dateRange(30, now);
  // P30 = the 30 days BEFORE T30 (so 60→30 days ago).
  const p30 = dateRange(30, new Date(now.getTime() - 30 * 86400000));

  // Run the three data pulls we need in parallel.
  const [t30Cust, p30Cust, t7Style, t30Style, openPo] = await Promise.all([
    customerRevenue(db, t30.from, t30.to),
    customerRevenue(db, p30.from, p30.to),
    styleQty(db, t7.from, t7.to),
    styleQty(db, t30.from, t30.to),
    openPoQtyByStyle(db),
  ]);

  // Merge customer T30 + P30 into one map, attach names.
  const byCustomer = new Map();
  for (const [id, rev] of (t30Cust.byCustomer || new Map()).entries()) {
    byCustomer.set(id, { t30Revenue: rev, p30Revenue: 0 });
  }
  for (const [id, rev] of (p30Cust.byCustomer || new Map()).entries()) {
    if (!byCustomer.has(id)) byCustomer.set(id, { t30Revenue: 0, p30Revenue: 0 });
    byCustomer.get(id).p30Revenue = rev;
  }
  await attachCustomerNames(db, byCustomer);

  // Merge style T7 + T30 + open-PO into one map.
  const byStyle = new Map();
  for (const [style, qty] of (t7Style.byStyle || new Map()).entries()) {
    byStyle.set(style, { t7Qty: qty, t30Qty: 0, openPoQty: 0 });
  }
  for (const [style, qty] of (t30Style.byStyle || new Map()).entries()) {
    if (!byStyle.has(style)) byStyle.set(style, { t7Qty: 0, t30Qty: 0, openPoQty: 0 });
    byStyle.get(style).t30Qty = qty;
  }
  for (const [style, qty] of (openPo.byStyle || new Map()).entries()) {
    if (!byStyle.has(style)) byStyle.set(style, { t7Qty: 0, t30Qty: 0, openPoQty: 0 });
    byStyle.get(style).openPoQty = qty;
  }

  // Run the rules. Each returns an array of insight rows ready to upsert.
  const insights = [
    ...detectCustomerChurnSignals(byCustomer, { now }),
    ...detectStyleRunaways(byStyle, { now }),
    ...detectStyleDeclines(byStyle, { now }),
  ];

  // Upsert by dedupe_key so re-running the same day is idempotent.
  // Insight rows already detected this week update headline/detail/metrics
  // (the underlying numbers may have shifted intraday).
  let upserted = 0;
  let upsertErr = null;
  if (insights.length > 0) {
    const rows = insights.map(i => ({
      rule:          i.rule,
      severity:      i.severity,
      subject_type:  i.subject_type,
      subject_id:    i.subject_id,
      subject_label: i.subject_label,
      headline:      i.headline,
      detail:        i.detail,
      metrics:       i.metrics,
      dedupe_key:    i.dedupe_key,
    }));
    const { error } = await db
      .from("ip_ai_proactive_insights")
      .upsert(rows, { onConflict: "dedupe_key" });
    if (error) upsertErr = error.message;
    else upserted = rows.length;
  }

  return res.status(200).json({
    started_at: now.toISOString(),
    customers_evaluated: byCustomer.size,
    styles_evaluated:    byStyle.size,
    insights_generated:  insights.length,
    insights_upserted:   upserted,
    upsert_error:        upsertErr,
    rule_breakdown: insights.reduce((acc, i) => {
      acc[i.rule] = (acc[i.rule] || 0) + 1;
      return acc;
    }, {}),
  });
}
