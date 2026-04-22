// api/marketplace/listings/:id
//
// GET — listing detail. Increments views by 1 on each hit (published only).

import { createClient } from "@supabase/supabase-js";
import { esgMapForVendors } from "../../../_lib/marketplace.js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("listings");
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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing listing id" });

  const { data, error } = await admin.from("marketplace_listings")
    .select("*, vendor:vendors(id, name)")
    .eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Listing not found" });

  if (data.status === "published") {
    await admin.from("marketplace_listings")
      .update({ views: (Number(data.views) || 0) + 1, updated_at: new Date().toISOString() })
      .eq("id", id);
    data.views = (Number(data.views) || 0) + 1;
  }

  const esg = await esgMapForVendors(admin, [data.vendor_id]);
  return res.status(200).json({ ...data, esg_overall_score: esg[data.vendor_id] ?? null });
}
