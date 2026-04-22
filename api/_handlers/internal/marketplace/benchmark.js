// api/internal/marketplace/benchmark
//
// GET — BenchmarkData rows for use in quote / catalog "market rate" context.
//   ?category=<text>   optional
//   ?metric=unit_price|lead_time|payment_terms|on_time_pct
//   ?period_start=<YYYY-MM-DD>  optional, defaults to latest available
// Response: { rows }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

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
  const category = url.searchParams.get("category");
  const metric = url.searchParams.get("metric");
  const periodStart = url.searchParams.get("period_start");

  let q = admin.from("benchmark_data").select("*")
    .order("period_end", { ascending: false });
  if (category) q = q.eq("category", category);
  if (metric) q = q.eq("metric", metric);
  if (periodStart) q = q.gte("period_start", periodStart);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Latest period per (category, metric) when not filtered further
  if (!periodStart) {
    const latest = {};
    for (const r of data || []) {
      const key = `${r.category}|${r.metric}`;
      if (!(key in latest)) latest[key] = r;
    }
    return res.status(200).json({ rows: Object.values(latest) });
  }
  return res.status(200).json({ rows: data || [] });
}
