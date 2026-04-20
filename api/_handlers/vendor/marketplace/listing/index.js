// api/vendor/marketplace/listing
//
// GET  — this vendor's own listing (single row; may be null).
// POST — create or upsert listing (starts at status='draft').
//   body: { title, description?, category?, capabilities[], certifications[],
//           geographic_coverage[], min_order_value?, lead_time_range? }

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  if (req.method === "GET") {
    const { data } = await admin.from("marketplace_listings").select("*")
      .eq("vendor_id", vendorId).maybeSingle();
    return res.status(200).json(data || null);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    if (!body?.title || !String(body.title).trim()) return res.status(400).json({ error: "title is required" });

    const payload = {
      title: String(body.title).trim(),
      description: body.description || null,
      category: body.category || null,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      certifications: Array.isArray(body.certifications) ? body.certifications : [],
      geographic_coverage: Array.isArray(body.geographic_coverage) ? body.geographic_coverage : [],
      min_order_value: body.min_order_value ? Number(body.min_order_value) : null,
      lead_time_range: body.lead_time_range || null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await admin.from("marketplace_listings").select("id, status").eq("vendor_id", vendorId).maybeSingle();
    if (existing?.id) {
      // Don't auto-demote published → draft on an edit; vendor toggles via /publish
      const { error } = await admin.from("marketplace_listings").update(payload).eq("id", existing.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ id: existing.id, upserted: "updated", status: existing.status });
    }
    const { data: inserted, error } = await admin.from("marketplace_listings")
      .insert({ vendor_id: vendorId, ...payload, status: "draft" })
      .select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(inserted);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
