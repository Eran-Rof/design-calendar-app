// api/internal/xoro-mirror/backfill-range
//
// POST { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', entity_id?: 'uuid' }
//
// Mirror a DATE RANGE in one shot: runs the full nightly pipeline (AR + AP +
// inventory mirror, then the daily summary JEs) for EVERY date in [from, to],
// each posting with its own date into its own period. Reuses the per-date
// orchestrator (runMirrorRange → runNightlyMirror), with the stale-fetch guard
// bypassed (an explicit historical backfill) and one aggregate result returned.
// Idempotent: re-running a range skips already-posted summary JEs and upserts
// mirror rows in place.
//
// Capped at MAX_RANGE_DAYS days per call to stay under the function time limit;
// split larger backfills into consecutive calls.

import { createClient } from "@supabase/supabase-js";
import { runMirrorRange, MAX_RANGE_DAYS } from "../../../cron/xoro-mirror-nightly.js";

export const config = { maxDuration: 300 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};
  const from = body.from;
  const to = body.to;
  if (!from || !ISO_DATE_RE.test(String(from))) return res.status(400).json({ error: "from (YYYY-MM-DD) is required" });
  if (!to || !ISO_DATE_RE.test(String(to))) return res.status(400).json({ error: "to (YYYY-MM-DD) is required" });
  if (String(from) > String(to)) return res.status(400).json({ error: `from (${from}) must be on or before to (${to})` });
  const entity_id_override = body.entity_id && UUID_RE.test(String(body.entity_id)) ? String(body.entity_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await runMirrorRange(admin, { from: String(from), to: String(to), entity_id_override });
    return res.status(200).json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Range/validation errors → 400 (client can fix + retry); everything else → 500.
    if (/max \d+|must be|on or before|YYYY-MM-DD|spans/.test(msg)) {
      return res.status(400).json({ error: msg, max_range_days: MAX_RANGE_DAYS });
    }
    return res.status(500).json({ error: msg });
  }
}
