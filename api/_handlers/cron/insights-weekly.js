// api/cron/insights-weekly
//
// Weekly AI insights generator. Runs all 6 detectors per active entity,
// inserts new ai_insights rows (deduped against existing unread rows),
// and expires stale 'new' rows.
//
// Scheduled via vercel.json at 06:00 UTC every Monday.

import { createClient } from "@supabase/supabase-js";
import { runInsightsForAllActiveEntities } from "../../_lib/insights.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const results = await runInsightsForAllActiveEntities({ admin });
  const totals = results.reduce((acc, r) => ({
    entities: acc.entities + 1,
    inserted: acc.inserted + (r.inserted || 0),
    expired:  acc.expired  + (r.expired  || 0),
    errors:   acc.errors   + (r.error ? 1 : 0),
  }), { entities: 0, inserted: 0, expired: 0, errors: 0 });

  return res.status(200).json({ ok: true, totals, results });
}
