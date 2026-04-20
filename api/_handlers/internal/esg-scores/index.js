// api/internal/esg-scores
//
// GET — latest ESG score per vendor (or all periods for a single vendor).
//   ?vendor_id=<uuid>         if set, returns all periods for that vendor
//   ?min_score=<0..100>       filter by overall_score >= value
//   default: latest period per vendor

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
  const vendorId = url.searchParams.get("vendor_id");
  const minScore = url.searchParams.get("min_score");

  if (vendorId) {
    const { data, error } = await admin.from("esg_scores")
      .select("*, vendor:vendors(id, name)")
      .eq("vendor_id", vendorId).order("period_end", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  // Latest period per vendor (naive: fetch all, pick highest period_end per vendor)
  const { data, error } = await admin.from("esg_scores")
    .select("*, vendor:vendors(id, name)")
    .order("period_end", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const latest = {};
  for (const s of data || []) {
    if (!latest[s.vendor_id]) latest[s.vendor_id] = s;
  }
  let rows = Object.values(latest);
  if (minScore !== null && minScore !== "") {
    const n = Number(minScore);
    if (Number.isFinite(n)) rows = rows.filter((r) => Number(r.overall_score || 0) >= n);
  }
  rows.sort((a, b) => Number(b.overall_score || 0) - Number(a.overall_score || 0));
  return res.status(200).json({ rows });
}
