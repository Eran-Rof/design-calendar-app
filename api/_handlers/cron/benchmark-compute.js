// api/cron/benchmark-compute
//
// Monthly benchmark compute. Populates benchmark_data for the prior full
// calendar month across three metrics, grouped by catalog category.
//
//   unit_price     — catalog_items.unit_price  (active items)
//   lead_time      — catalog_items.lead_time_days (active items)
//   on_time_pct    — vendor_scorecards.on_time_delivery_pct for scorecards
//                    whose period overlaps the prior month; attributed to the
//                    vendor's dominant catalog category (scorecards have no
//                    native category).
//
// Publishing threshold: a (category, metric) bucket is published only if it
// received contributions from >= MIN_VENDORS_FOR_PUBLISH distinct vendors.
// This prevents exposing individual vendor data through a thin sample.
//
// Idempotency: prior rows for the same (category, metric, period) are
// deleted before inserting.
//
// Scheduled: 1st of each month at 07:00 UTC.

import { createClient } from "@supabase/supabase-js";
import { percentiles, priorMonthRange, aggregateByCategory, MIN_VENDORS_FOR_PUBLISH } from "../../_lib/benchmark.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const now = url.searchParams.get("as_of") ? new Date(url.searchParams.get("as_of")) : new Date();
  const { period_start, period_end } = priorMonthRange(now);

  const result = {
    started_at: new Date().toISOString(),
    period_start, period_end,
    published: 0, skipped_small_sample: 0, skipped_no_data: 0,
    by_metric: { unit_price: { published: 0, categories: [] }, lead_time: { published: 0, categories: [] }, on_time_pct: { published: 0, categories: [] } },
    errors: [],
  };

  try {
    const [unitPricePublished, leadTimePublished, onTimePublished] = await Promise.all([
      computeAndStore(admin, result, "unit_price",  await gatherCatalogRows(admin, "unit_price")),
      computeAndStore(admin, result, "lead_time",   await gatherCatalogRows(admin, "lead_time_days")),
      computeAndStore(admin, result, "on_time_pct", await gatherOnTimeRows(admin, period_start, period_end)),
    ]);
    result.published = unitPricePublished + leadTimePublished + onTimePublished;
  } catch (err) {
    result.errors.push({ error: err?.message || String(err) });
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}

async function gatherCatalogRows(admin, field) {
  const { data } = await admin
    .from("catalog_items")
    .select(`vendor_id, category, ${field}`)
    .eq("status", "active")
    .not("category", "is", null)
    .not(field, "is", null);
  return (data || []).map((r) => ({ vendor_id: r.vendor_id, category: r.category, value: r[field] }));
}

async function gatherOnTimeRows(admin, period_start, period_end) {
  // Scorecards whose period overlaps the compute period
  const { data: cards } = await admin
    .from("vendor_scorecards")
    .select("vendor_id, on_time_delivery_pct, period_start, period_end")
    .not("on_time_delivery_pct", "is", null)
    .lte("period_start", period_end)
    .gte("period_end", period_start);
  if (!cards || cards.length === 0) return [];

  // Dominant category per vendor (from active catalog items)
  const vendorIds = [...new Set(cards.map((c) => c.vendor_id))];
  if (vendorIds.length === 0) return [];
  const { data: items } = await admin
    .from("catalog_items")
    .select("vendor_id, category")
    .in("vendor_id", vendorIds)
    .eq("status", "active")
    .not("category", "is", null);
  const counts = {};
  for (const it of items || []) {
    const m = (counts[it.vendor_id] ||= {});
    m[it.category] = (m[it.category] || 0) + 1;
  }
  const dominant = {};
  for (const vId of Object.keys(counts)) {
    const entries = Object.entries(counts[vId]).sort((a, b) => b[1] - a[1]);
    dominant[vId] = entries[0][0];
  }

  // Keep the most recent scorecard per vendor in this window
  const latestByVendor = {};
  for (const c of cards) {
    const prev = latestByVendor[c.vendor_id];
    if (!prev || new Date(c.period_end) > new Date(prev.period_end)) latestByVendor[c.vendor_id] = c;
  }

  return Object.values(latestByVendor).map((c) => ({
    vendor_id: c.vendor_id,
    category: dominant[c.vendor_id] || null,
    value: c.on_time_delivery_pct,
  })).filter((r) => r.category);
}

async function computeAndStore(admin, result, metric, rows) {
  const { period_start, period_end } = result;
  if (!rows || rows.length === 0) { result.skipped_no_data += 1; return 0; }

  const agg = aggregateByCategory(rows, { valueField: "value" });
  const toInsert = [];
  const categoriesToReplace = [];
  for (const [category, b] of Object.entries(agg)) {
    const vendorCount = b.vendorIds.size;
    if (vendorCount < MIN_VENDORS_FOR_PUBLISH) {
      result.skipped_small_sample += 1;
      continue;
    }
    const p = percentiles(b.values);
    toInsert.push({
      category, metric,
      percentile_25: p.p25, percentile_50: p.p50, percentile_75: p.p75, percentile_90: p.p90,
      sample_size: vendorCount,
      period_start, period_end,
    });
    categoriesToReplace.push(category);
    result.by_metric[metric].categories.push({ category, sample_size: vendorCount });
  }

  if (categoriesToReplace.length) {
    // Delete prior rows for these categories / metric / period (idempotency)
    await admin.from("benchmark_data")
      .delete()
      .in("category", categoriesToReplace)
      .eq("metric", metric)
      .eq("period_start", period_start)
      .eq("period_end", period_end);
  }

  if (toInsert.length) {
    const { error } = await admin.from("benchmark_data").insert(toInsert);
    if (error) { result.errors.push({ metric, error: error.message }); return 0; }
  }
  result.by_metric[metric].published = toInsert.length;
  return toInsert.length;
}
