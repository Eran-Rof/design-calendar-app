// api/internal/xoro-mirror/backfill-job
//
// POST { from, to, chunk_days?, entity_id? } — enqueue an UNATTENDED range
// backfill. Inserts a pending job into xoro_mirror_backfill_jobs and returns it;
// the xoro-mirror-backfill-worker cron (every ~2 min) drains it a chunk at a
// time. The operator can close the tab — no request stays open for the work.
//
// GET [?limit=&status=] — recent backfill jobs with progress, for the status UI.

import { createClient } from "@supabase/supabase-js";
import { enqueueBackfillJob } from "../../../_lib/xoro-mirror/backfillJobs.js";

export const config = { maxDuration: 20 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}
async function rofEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    let q = admin
      .from("xoro_mirror_backfill_jobs")
      .select("id, from_date, to_date, cursor_date, status, days_total, days_done, totals, je_count, last_error, created_at, updated_at, completed_at")
      .order("created_at", { ascending: false });
    const status = req.query?.status;
    if (status && ["pending", "running", "complete", "failed", "cancelled"].includes(String(status))) q = q.eq("status", String(status));
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 100);
    q = q.limit(limit);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const from = body.from, to = body.to;
  if (!from || !ISO_DATE_RE.test(String(from))) return res.status(400).json({ error: "from (YYYY-MM-DD) is required" });
  if (!to || !ISO_DATE_RE.test(String(to))) return res.status(400).json({ error: "to (YYYY-MM-DD) is required" });
  if (String(from) > String(to)) return res.status(400).json({ error: `from (${from}) must be on or before to (${to})` });
  const chunk_days = Number.isInteger(body.chunk_days) && body.chunk_days > 0 && body.chunk_days <= 45 ? body.chunk_days : 30;
  const created_by_user_id = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  const entity_id = (body.entity_id && UUID_RE.test(String(body.entity_id)) ? String(body.entity_id) : null) || await rofEntityId(admin);
  if (!entity_id) return res.status(500).json({ error: "Default entity (ROF) not found" });

  try {
    const job = await enqueueBackfillJob(admin, { entity_id, from: String(from), to: String(to), chunk_days, created_by_user_id });
    return res.status(202).json({ queued: true, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/must be|on or before|YYYY-MM-DD/.test(msg)) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: msg });
  }
}
