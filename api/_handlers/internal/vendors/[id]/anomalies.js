// api/internal/vendors/:id/anomalies
//
// GET — anomaly history for one vendor (all statuses, newest first).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function getVendorId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("vendors");
  return idx >= 0 ? parts[idx + 1] : null;
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
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  const { data, error } = await admin
    .from("anomaly_flags")
    .select("*")
    .eq("vendor_id", vendorId)
    .order("detected_at", { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(data || []);
}
