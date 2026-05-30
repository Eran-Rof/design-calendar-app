// api/internal/recon/run-all
//
// Tangerine P9-8 — Manual trigger for the 5-engine recon orchestrator.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.6 (D10
// manual re-run path).
//
// POST /api/internal/recon/run-all
//   body: {
//     period_start: 'YYYY-MM-DD',
//     period_end:   'YYYY-MM-DD',
//     entity_id?:   <uuid>     // default: all entities
//   }
//
// Calls the same per-engine sequence as the Monday cron (AP → AR →
// Cash → Inventory → GL), updates entities.parallel_run_status, and
// fires variance notifications for each engine that lands status='variance'
// or 'error'. Returns the same summary shape the cron emits.
//
// This is the "Re-run all" button on the InternalReconciliationDashboard.
// It's also the path operators take when they want to backfill a
// specific historical week after a Xoro retroactive edit (cadence is
// still 'weekly' — D11 replay is a separate per-engine handler).
//
// Auth: standard authenticateInternalCaller (Bearer / X-Internal-Token,
// soft-open until INTERNAL_API_TOKEN is set in Vercel).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { runReconWeekly } from "../../../cron/recon-weekly.js";

export const config = { maxDuration: 600 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Parse + validate body. Exported for unit tests.
 */
export function validateBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!b.period_start || typeof b.period_start !== "string" || !ISO_DATE_RE.test(b.period_start)) {
    return { error: "period_start must be YYYY-MM-DD" };
  }
  if (!b.period_end || typeof b.period_end !== "string" || !ISO_DATE_RE.test(b.period_end)) {
    return { error: "period_end must be YYYY-MM-DD" };
  }
  if (b.period_end < b.period_start) {
    return { error: "period_end must be >= period_start" };
  }
  let entity_id = null;
  if (b.entity_id != null && b.entity_id !== "") {
    if (typeof b.entity_id !== "string" || !UUID_RE.test(b.entity_id)) {
      return { error: "entity_id must be a uuid when provided" };
    }
    entity_id = b.entity_id;
  }
  return {
    data: {
      period_start: b.period_start,
      period_end: b.period_end,
      entity_id,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Auth.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 2. Body parse.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // 3. Admin client.
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 4. Drive orchestrator.
  let summary;
  try {
    summary = await runReconWeekly(admin, {
      period_start: v.data.period_start,
      period_end: v.data.period_end,
      entity_id_override: v.data.entity_id || undefined,
    });
  } catch (err) {
    return res.status(500).json({
      error: `runReconWeekly threw: ${err?.message || String(err)}`,
    });
  }

  return res.status(200).json({
    ok: true,
    ...summary,
  });
}
