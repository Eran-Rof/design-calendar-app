// api/internal/analytics/sustainability-trend
//
// GET — monthly average ESG overall scores across all vendors.
//   ?months=<n>  default 12
// Response: { range, points: [{ period, avg_overall, avg_env, avg_social, avg_gov, vendor_count }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const months = Math.min(Math.max(Number(url.searchParams.get("months")) || 12, 1), 36);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);

  const { data } = await admin.from("esg_scores")
    .select("vendor_id, period_end, environmental_score, social_score, governance_score, overall_score")
    .gte("period_end", since.toISOString().slice(0, 10))
    .order("period_end", { ascending: true });

  // Bucket by YYYY-MM of period_end
  const buckets = {};
  for (const r of data || []) {
    const key = String(r.period_end).slice(0, 7);
    const b = (buckets[key] ||= { vendor_ids: new Set(), env: [], social: [], gov: [], overall: [] });
    if (!b.vendor_ids.has(r.vendor_id)) {
      b.vendor_ids.add(r.vendor_id);
      if (r.environmental_score != null) b.env.push(Number(r.environmental_score));
      if (r.social_score != null)        b.social.push(Number(r.social_score));
      if (r.governance_score != null)    b.gov.push(Number(r.governance_score));
      if (r.overall_score != null)       b.overall.push(Number(r.overall_score));
    }
  }
  const avg = (a) => a.length ? Number((a.reduce((s, n) => s + n, 0) / a.length).toFixed(2)) : null;
  const points = Object.keys(buckets).sort().map((period) => ({
    period,
    vendor_count: buckets[period].vendor_ids.size,
    avg_env:      avg(buckets[period].env),
    avg_social:   avg(buckets[period].social),
    avg_gov:      avg(buckets[period].gov),
    avg_overall:  avg(buckets[period].overall),
  }));

  return res.status(200).json({
    range: { from: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
    points,
  });
}
