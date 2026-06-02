// api/internal/xoro-mirror/inventory
//
// POST body { snapshot_date: "YYYY-MM-DD" }
//
// Manually triggers the Tangerine T10-4 inventory-layer rebuild for the ROF
// entity from the latest ip_inventory_snapshot rows on or before
// `snapshot_date`.  Idempotent — re-running on the same date drops and
// rebuilds all source_kind='xoro_mirror_snapshot' rows; operator-typed
// inventory layers are never touched.
//
// One xoro_mirror_runs row is written (domain='inventory') summarising the
// rebuild.  Reference: docs/tangerine/T10-shadow-mirror-architecture.md §4.3.

import { createClient } from "@supabase/supabase-js";
import { rebuildInventoryLayersForDate } from "../../../_lib/xoro-mirror/inventory.js";

export const config = { maxDuration: 60 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveRofEntityId(admin) {
  const { data, error } = await admin
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const snapshot_date = typeof body.snapshot_date === "string" ? body.snapshot_date.trim() : "";
  if (!DATE_RE.test(snapshot_date)) {
    return res.status(400).json({ error: "snapshot_date must be YYYY-MM-DD" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity_id = await resolveRofEntityId(admin);
  if (!entity_id) {
    return res.status(500).json({ error: "ROF entity not found (entities.code='ROF')" });
  }

  // Open the run row up front so a crash mid-rebuild still leaves a trail.
  let runId = null;
  {
    const { data, error } = await admin
      .from("xoro_mirror_runs")
      .insert({
        entity_id,
        domain: "inventory",
        mirror_date: snapshot_date,
        status: "running",
      })
      .select("id")
      .single();
    if (error) {
      return res.status(500).json({ error: `Could not open run row: ${error.message}` });
    }
    runId = data.id;
  }

  let summary;
  try {
    summary = await rebuildInventoryLayersForDate(admin, entity_id, snapshot_date);
  } catch (err) {
    await admin.from("xoro_mirror_runs").update({
      status: "failed",
      errors: [{ stage: "exception", message: err?.message || String(err) }],
      completed_at: new Date().toISOString(),
    }).eq("id", runId);
    return res.status(500).json({ error: err?.message || "Rebuild failed", run_id: runId });
  }

  const status = summary.errors.length > 0 ? "failed" : "complete";
  const { error: updateErr } = await admin
    .from("xoro_mirror_runs")
    .update({
      status,
      rows_upserted: summary.rows_upserted,
      rows_deleted: summary.rows_deleted,
      rows_unchanged: 0,
      errors: summary.errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (updateErr) {
    return res.status(500).json({
      error: `Rebuild ran but run-row update failed: ${updateErr.message}`,
      run_id: runId,
      summary,
    });
  }

  return res.status(200).json({ run_id: runId, ...summary });
}
