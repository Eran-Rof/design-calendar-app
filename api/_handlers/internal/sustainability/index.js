// api/internal/sustainability
//
// GET — list sustainability reports across all vendors.
//   ?status=submitted|under_review|approved|rejected
//   ?vendor_id=<uuid>
//   ?period_start=<YYYY-MM-DD> (matches reports overlapping the given date)

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
  const status   = url.searchParams.get("status");
  const vendorId = url.searchParams.get("vendor_id");
  const periodStart = url.searchParams.get("period_start");

  let q = admin.from("sustainability_reports")
    .select("*, vendor:vendors(id, name)")
    .order("submitted_at", { ascending: false });
  if (status)   q = q.eq("status", status);
  if (vendorId) q = q.eq("vendor_id", vendorId);
  if (periodStart) q = q.lte("reporting_period_start", periodStart).gte("reporting_period_end", periodStart);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
