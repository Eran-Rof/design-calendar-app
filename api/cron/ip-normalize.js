// api/cron/ip-normalize.js
//
// Every 30 minutes: picks up raw payloads that haven't been normalized
// yet (normalized_at IS NULL) and writes normalized rows into the ip_*
// planning tables. Fully idempotent — upserts are keyed on source_line_key
// so re-running after a failure is always safe.
//
// Processes up to BATCH payloads per invocation. When a backlog builds up,
// subsequent runs drain it automatically.

import { createClient } from "@supabase/supabase-js";
import { loadMasters, processXoroPayload, processShopifyPayload } from "../_lib/ip-normalize-pipeline.js";

export const config = { maxDuration: 300 };

const BATCH = 20;

function admin() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const a = admin();
  if (!a) return res.status(500).json({ error: "Supabase admin not configured" });

  const { data: job, error: startErr } = await a
    .from("ip_job_runs")
    .insert({
      job_type: "normalization",
      status: "running",
      started_at: new Date().toISOString(),
      initiated_by: "cron:ip-normalize",
      input_json: {},
    })
    .select("id")
    .single();
  if (startErr) return res.status(500).json({ error: startErr.message });

  const summary = {
    xoro: { inserted: 0, skipped: 0, errors: 0, payloads: 0 },
    shopify: { inserted: 0, skipped: 0, errors: 0, payloads: 0 },
  };

  try {
    const masters = await loadMasters(a);

    // Xoro
    const { data: xoroRaws } = await a
      .from("raw_xoro_payloads")
      .select("id,endpoint,period_end,payload,storefront_code")
      .is("normalized_at", null)
      .order("ingested_at", { ascending: true })
      .limit(BATCH);

    for (const raw of xoroRaws ?? []) {
      try {
        const r = await processXoroPayload(a, raw, masters);
        summary.xoro.inserted += r.inserted ?? 0;
        summary.xoro.skipped  += r.skipped  ?? 0;
        summary.xoro.errors   += r.errors?.length ?? 0;
        summary.xoro.payloads++;
        await a.from("raw_xoro_payloads").update({
          normalized_at: new Date().toISOString(),
          normalization_error: r.errors?.length > 0
            ? r.errors.slice(0, 3).map((e) => e.error ?? String(e)).join("; ")
            : null,
        }).eq("id", raw.id);
      } catch (e) {
        summary.xoro.errors++;
        await a.from("raw_xoro_payloads")
          .update({ normalization_error: e.message })
          .eq("id", raw.id);
      }
    }

    // Shopify
    const { data: shopifyRaws } = await a
      .from("raw_shopify_payloads")
      .select("id,endpoint,period_end,payload,storefront_code")
      .is("normalized_at", null)
      .order("ingested_at", { ascending: true })
      .limit(BATCH);

    for (const raw of shopifyRaws ?? []) {
      try {
        const r = await processShopifyPayload(a, raw, masters);
        summary.shopify.inserted += r.inserted ?? 0;
        summary.shopify.skipped  += r.skipped  ?? 0;
        summary.shopify.errors   += r.errors?.length ?? 0;
        summary.shopify.payloads++;
        await a.from("raw_shopify_payloads").update({
          normalized_at: new Date().toISOString(),
          normalization_error: r.errors?.length > 0
            ? r.errors.slice(0, 3).map((e) => e.error ?? String(e)).join("; ")
            : null,
        }).eq("id", raw.id);
      } catch (e) {
        summary.shopify.errors++;
        await a.from("raw_shopify_payloads")
          .update({ normalization_error: e.message })
          .eq("id", raw.id);
      }
    }

    await a.from("ip_job_runs").update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
      output_json: summary,
    }).eq("id", job.id);

    return res.status(200).json({ ok: true, ...summary });
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
