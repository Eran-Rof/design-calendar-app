// api/internal/vendors/diversity
//
// GET — list diversity profiles across all vendors (includes vendor name).
//   ?pending=true  returns only unverified profiles.

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
  const pending = url.searchParams.get("pending") === "true";

  let q = admin.from("diversity_profiles")
    .select("*, vendor:vendors(id, name)")
    .order("updated_at", { ascending: false });
  if (pending) q = q.eq("verified", false);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || []).map((r) => ({ ...r, vendor_name: r.vendor?.name || null }));
  return res.status(200).json({ rows });
}
