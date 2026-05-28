// api/internal/xoro-mirror/summary-je
//
// POST. Cross-cutter T10-5 — daily summary JE poster.
//
// Body: { mirror_date: 'YYYY-MM-DD', actor_user_id?: 'uuid' }
//
// After AR + AP + inventory mirrors have run + flipped their xoro_mirror_runs
// row to status='complete', this endpoint posts the daily summary JE for each
// domain. See docs/tangerine/T10-shadow-mirror-architecture.md §4.4.
//
// Used by:
//   - the future Wave C nightly cron (api/cron/xoro-mirror-nightly.js) —
//     called after the inventory rebuild step
//   - the future Wave D Shadow Mirror Status admin panel "Post summary JEs"
//     button

import { createClient } from "@supabase/supabase-js";
import { postDailySummaryJes } from "../../../_lib/xoro-mirror/summary-je.js";

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
  const actor_user_id = body?.actor_user_id || null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve the default ROF entity (matches the convention in ar.js).
  const { data: entity, error: eErr } = await admin
    .from("entities")
    .select("id, code")
    .eq("code", "ROF")
    .maybeSingle();
  if (eErr || !entity) {
    return res.status(500).json({ error: "Default entity (ROF) not found" });
  }

  let summary;
  try {
    summary = await postDailySummaryJes(admin, entity.id, mirror_date, { actor_user_id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: message });
  }

  return res.status(200).json({
    entity_id: entity.id,
    mirror_date,
    ...summary,
  });
}
