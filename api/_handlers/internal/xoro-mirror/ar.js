// api/internal/xoro-mirror/ar
//
// POST. Cross-cutter T10-2 — manual trigger for the AR shadow mirror.
//
// Body: { mirror_date: 'YYYY-MM-DD' }
//
// Looks up the default ROF entity, calls mirrorArForDate, records an
// xoro_mirror_runs row with domain='ar', and returns the summary as JSON.
//
// Used by:
//   - the future Wave C nightly cron (api/cron/xoro-mirror-nightly.js)
//   - the future Wave D Shadow Mirror Status admin panel "Manual re-run" button

import { createClient } from "@supabase/supabase-js";
import { mirrorArForDate } from "../../../_lib/xoro-mirror/ar.js";

export const config = { maxDuration: 60 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const mirror_date = body?.mirror_date;
  if (!mirror_date || !ISO_DATE_RE.test(String(mirror_date))) {
    return res.status(400).json({ error: "mirror_date (YYYY-MM-DD) is required" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve the default ROF entity.
  const { data: entity, error: eErr } = await admin
    .from("entities")
    .select("id, code")
    .eq("code", "ROF")
    .maybeSingle();
  if (eErr || !entity) {
    return res.status(500).json({ error: "Default entity (ROF) not found" });
  }

  // Open the run row.
  const { data: runRow, error: runErr } = await admin
    .from("xoro_mirror_runs")
    .insert({
      entity_id: entity.id,
      domain: "ar",
      mirror_date,
      status: "running",
    })
    .select("id")
    .maybeSingle();
  if (runErr || !runRow) {
    // 23505 → unique violation = a run for this (entity, domain, date) already
    // exists. We still proceed and update that row at the end, but without
    // its id we can't update — surface this as a conflict.
    return res.status(409).json({
      error: `xoro_mirror_runs open failed: ${runErr?.message || "no row returned"}`,
    });
  }

  let summary;
  try {
    summary = await mirrorArForDate(admin, entity.id, mirror_date);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .from("xoro_mirror_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        errors: [{ kind: "uncaught", message }],
      })
      .eq("id", runRow.id);
    return res.status(500).json({ error: message });
  }

  await admin
    .from("xoro_mirror_runs")
    .update({
      status: "complete",
      rows_upserted: summary.rows_upserted,
      rows_unchanged: summary.rows_unchanged,
      // rows_deleted stays 0 — AR mirror doesn't delete invoices.
      errors: summary.errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  return res.status(200).json({
    run_id: runRow.id,
    entity_id: entity.id,
    domain: "ar",
    mirror_date,
    ...summary,
  });
}
