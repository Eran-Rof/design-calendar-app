// api/vendor/marketplace/listing/publish
//
// POST — flips status to 'published' on the vendor's listing.
//   body: { publish: true|false }  default true (true → published, false → draft)

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const publish = body?.publish !== false;

  const { data: existing } = await admin.from("marketplace_listings").select("id, status, title").eq("vendor_id", vendorId).maybeSingle();
  if (!existing) return res.status(404).json({ error: "No listing to publish. Create one first." });

  const next = publish ? "published" : "draft";
  const { error } = await admin.from("marketplace_listings")
    .update({ status: next, updated_at: new Date().toISOString() }).eq("id", existing.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ id: existing.id, status: next });
}
