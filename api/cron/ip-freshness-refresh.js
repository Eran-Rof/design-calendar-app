// api/cron/ip-freshness-refresh.js
//
// Every 4 hours: compute Phase 7 data-freshness signals server-side and
// record a job_run row. The admin dashboard still does its own on-demand
// compute; this cron is purely so stale data is visible even when no
// planner has opened the admin page recently.
//
// Why a job row? It gives the admin Jobs tab a heartbeat — easy to spot
// when the cron stops firing.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function admin() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}

const HOUR = 1000 * 60 * 60;

// Mirror of src/inventory-planning/admin/services/dataFreshnessService.ts —
// keep these lists in sync when a new entity_type is added to either side.
const SOURCES = [
  { entity: "xoro_sales_history",   table: "raw_xoro_payloads",      where: "endpoint=eq.sales-history",      column: "ingested_at" },
  { entity: "xoro_inventory",       table: "raw_xoro_payloads",      where: "endpoint=eq.inventory-snapshot", column: "ingested_at" },
  { entity: "xoro_open_pos",        table: "raw_xoro_payloads",      where: "endpoint=eq.open-pos",           column: "ingested_at" },
  { entity: "shopify_orders",       table: "raw_shopify_payloads",   where: "endpoint=eq.orders",             column: "ingested_at" },
  { entity: "shopify_products",     table: "raw_shopify_payloads",   where: "endpoint=eq.products",           column: "ingested_at" },
  { entity: "planning_run",         table: "ip_planning_runs",       where: null,                             column: "updated_at" },
  { entity: "wholesale_forecast",   table: "ip_wholesale_forecast",  where: null,                             column: "updated_at" },
  { entity: "ecom_forecast",        table: "ip_ecom_forecast",       where: null,                             column: "updated_at" },
];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const a = admin();
  if (!a) return res.status(500).json({ error: "Supabase admin not configured" });

  const startedAt = new Date().toISOString();
  const { data: job, error: startErr } = await a.from("ip_job_runs").insert({
    job_type: "freshness_refresh",
    status: "running",
    started_at: startedAt,
    initiated_by: "cron:ip-freshness-refresh",
    input_json: {},
  }).select("id").single();
  if (startErr) return res.status(500).json({ error: startErr.message });

  try {
    // Thresholds.
    const { data: thresholds } = await a.from("ip_data_freshness_thresholds").select("*");
    const tByEntity = new Map((thresholds ?? []).map((t) => [t.entity_type, t]));

    const signals = [];
    for (const src of SOURCES) {
      let q = a.from(src.table).select(src.column).order(src.column, { ascending: false }).limit(1);
      if (src.where) {
        // Manual filter parse — keep it tiny.
        const [k, v] = src.where.split("=");
        const val = v.replace("eq.", "");
        q = q.eq(k, val);
      }
      const { data } = await q;
      const last = data?.[0]?.[src.column] ?? null;
      const age = last ? Math.round((Date.now() - Date.parse(last)) / HOUR) : null;
      const t = tByEntity.get(src.entity);
      const severity = !t
        ? "unknown"
        : age == null
          ? "warning"
          : age <= t.max_age_hours
            ? "fresh"
            : t.severity;
      signals.push({ entity: src.entity, last, age_hours: age, severity, threshold: t?.max_age_hours ?? null });
    }

    await a.from("ip_job_runs").update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
      output_json: { signals, counted: signals.length },
    }).eq("id", job.id);

    return res.status(200).json({ ok: true, signals });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await a.from("ip_job_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: msg,
    }).eq("id", job.id);
    return res.status(500).json({ error: msg });
  }
}
