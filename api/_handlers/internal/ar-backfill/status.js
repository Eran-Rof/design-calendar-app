// api/internal/ar-backfill/status
//
// GET — return the latest backfill activity for the default entity.
// Query params: ?run_id=<uuid> filters to a specific run.
//   Default: returns the most recent 50 checkpoint rows.
//
// Returns:
//   {
//     checkpoint_log:        [...most recent 50],
//     unmatched_customers:   [...most recent 50 unmatched rows],
//     skipped_cogs:          [...most recent 50 skipped lines],
//     reconciliation:        [...rows from v_ar_backfill_reconciliation
//                             where variance != 0 limit 24]
//   }
//
// Tangerine P4-8.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const runIdRaw = (url.searchParams.get("run_id") || "").trim();
  const runId = runIdRaw && UUID_RE.test(runIdRaw) ? runIdRaw : null;
  if (runIdRaw && !runId) {
    return res.status(400).json({ error: "run_id must be a UUID" });
  }

  const checkpointQ = admin.from("bf_backfill_checkpoint_log")
    .select("*").eq("entity_id", entity.id)
    .order("started_at", { ascending: false }).limit(50);
  const unmatchedQ = admin.from("bf_unmatched_customers_log")
    .select("*").eq("entity_id", entity.id)
    .order("logged_at", { ascending: false }).limit(50);
  const skippedQ = admin.from("bf_skipped_cogs_log")
    .select("*").eq("entity_id", entity.id)
    .order("logged_at", { ascending: false }).limit(50);

  if (runId) {
    checkpointQ.eq("backfill_run_id", runId);
    unmatchedQ.eq("backfill_run_id", runId);
    skippedQ.eq("backfill_run_id", runId);
  }

  const [cp, um, sk] = await Promise.all([checkpointQ, unmatchedQ, skippedQ]);
  if (cp.error) return res.status(500).json({ error: cp.error.message });

  // Reconciliation rows (best-effort — view may not exist yet on stale DBs).
  let recon = [];
  try {
    const { data: r } = await admin.from("v_ar_backfill_reconciliation")
      .select("*")
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(24);
    recon = r || [];
  } catch { /* view missing — return empty */ }

  return res.status(200).json({
    run_id: runId,
    checkpoint_log: cp.data || [],
    unmatched_customers: um.data || [],
    skipped_cogs: sk.data || [],
    reconciliation: recon,
  });
}
