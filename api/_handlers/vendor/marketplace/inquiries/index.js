// api/vendor/marketplace/inquiries
//
// GET — inquiries received on this vendor's listing.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  const { data: listing } = await admin.from("marketplace_listings").select("id, title").eq("vendor_id", vendorId).maybeSingle();
  if (!listing) return res.status(200).json({ rows: [] });

  const { data, error } = await admin.from("marketplace_inquiries")
    .select("*, entity:entities(id, name)")
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
