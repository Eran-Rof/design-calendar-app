// api/internal/xoro-mirror-runs
//
// GET [?limit=&domain=&status=] — recent Shadow-Mirror runs from
// xoro_mirror_runs, newest first, for the Shadow Mirror Status panel
// (src/tanda/InternalShadowMirrorStatus.tsx). Returns a plain array of rows
// (the panel does its own latest-per-domain + 30-day grouping).
//
// This read endpoint was referenced by the T10-7 status panel but never
// shipped, so the panel 404'd ("No route for /api/internal/xoro-mirror-runs")
// and rendered every domain as "No successful run yet" even though the nightly
// accounting mirror (xoro-mirror-nightly, 01:30 UTC) runs fine — which also
// surfaced as a bogus "mirror failed" on the Today page.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const DOMAINS = new Set(["ar", "ap", "inventory", "summary_je"]);
const STATUSES = new Set(["running", "complete", "failed", "skipped_no_change", "skipped_stale_xoro"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Newest first: the panel picks the latest-per-domain for its cards and
  // buckets by mirror_date for the 30-day grid, so recency ordering on
  // started_at is what it expects. Cap at 2000 to bound the payload.
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 500, 1), 2000);

  let q = admin
    .from("xoro_mirror_runs")
    .select("id, entity_id, domain, mirror_date, rows_upserted, rows_deleted, rows_unchanged, je_id, errors, started_at, completed_at, status")
    .order("started_at", { ascending: false })
    .limit(limit);

  const domain = req.query?.domain;
  if (domain && DOMAINS.has(String(domain))) q = q.eq("domain", String(domain));
  const status = req.query?.status;
  if (status && STATUSES.has(String(status))) q = q.eq("status", String(status));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
