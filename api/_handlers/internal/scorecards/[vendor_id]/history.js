// api/internal/scorecards/:vendor_id/history.js
//
// GET — full scorecard history for one vendor (newest first).
// Suitable for rendering a trend chart on the internal vendor page.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  // .../internal/scorecards/<vendor_id>/history
  const idx = parts.lastIndexOf("history");
  return idx > 0 ? parts[idx - 1] : null;
}

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

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor_id" });

  const [vRes, scRes] = await Promise.all([
    admin.from("vendors").select("id, name").eq("id", vendorId).maybeSingle(),
    admin.from("vendor_scorecards")
      .select("*")
      .eq("vendor_id", vendorId)
      .order("period_start", { ascending: false }),
  ]);
  if (vRes.error)  return res.status(500).json({ error: vRes.error.message });
  if (scRes.error) return res.status(500).json({ error: scRes.error.message });
  if (!vRes.data)  return res.status(404).json({ error: "Vendor not found" });

  return res.status(200).json({
    vendor: { id: vRes.data.id, name: vRes.data.name },
    history: scRes.data || [],
  });
}
