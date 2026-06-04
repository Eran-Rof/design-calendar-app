// api/cron/ip-integration-health.js
//
// Every 15 minutes: recompute integration status rows in
// ip_integration_health based on last_success_at vs configured
// freshness threshold. The admin UI does the same compute when opened;
// this cron keeps the stored `status` column fresh for anything that
// reads it without opening the dashboard (e.g. a later alerting layer).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function admin() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}

const HOUR = 1000 * 60 * 60;

// Map integration endpoint → freshness threshold entity_type.
// Mirrors the UI-side default threshold lookup.
function thresholdEntityFor(row) {
  return `${row.system_name}_${row.endpoint.replace(/-/g, "_")}`;
}

function computeStatus(row, thresholdHours) {
  if (!row.last_attempt_at) return "unknown";
  if (row.last_error_at && (!row.last_success_at || row.last_error_at > row.last_success_at)) return "error";
  if (row.last_success_at) {
    const age = (Date.now() - Date.parse(row.last_success_at)) / HOUR;
    if (age > thresholdHours) return "warning";
    return "healthy";
  }
  return "unknown";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const a = admin();
  if (!a) return res.status(500).json({ error: "Supabase admin not configured" });

  const { data: job, error: startErr } = await a.from("ip_job_runs").insert({
    job_type: "integration_health_refresh",
    status: "running",
    started_at: new Date().toISOString(),
    initiated_by: "cron:ip-integration-health",
    input_json: {},
  }).select("id").single();
  if (startErr) return res.status(500).json({ error: startErr.message });

  try {
    const [{ data: rows }, { data: thresholds }] = await Promise.all([
      a.from("ip_integration_health").select("*"),
      a.from("ip_data_freshness_thresholds").select("*"),
    ]);
    const tByEntity = new Map((thresholds ?? []).map((t) => [t.entity_type, t.max_age_hours]));

    const patches = [];
    for (const row of rows ?? []) {
      const entity = thresholdEntityFor(row);
      const threshold = tByEntity.get(entity) ?? 24;
      const next = computeStatus(row, threshold);
      if (next !== row.status) {
        await a.from("ip_integration_health").update({ status: next }).eq("id", row.id);
        patches.push({ id: row.id, from: row.status, to: next });
      }
    }

    await a.from("ip_job_runs").update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
      output_json: { rows_checked: rows?.length ?? 0, patches },
    }).eq("id", job.id);

    return res.status(200).json({ ok: true, patches });
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
