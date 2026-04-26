// api/vendor/diversity-profile
//
// GET  — vendor's diversity profile (single row per vendor).
// POST — create or upsert the profile (insert first time, update thereafter).

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 20 };

const KNOWN_BUSINESS_TYPES = ["minority_owned", "women_owned", "veteran_owned", "lgbtq_owned", "disability_owned", "small_business", "hub_zone"];

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
    const { data } = await admin.from("diversity_profiles").select("*").eq("vendor_id", vendorId).maybeSingle();
    return res.status(200).json(data || null);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    // Path-injection guard — certificate_file_url must live under the caller's folder.
    const cert = body?.certificate_file_url;
    if (cert && (typeof cert !== "string" || !cert.startsWith(`${vendorId}/`))) {
      return res.status(403).json({ error: "certificate_file_url must be under the caller's vendor folder" });
    }
    const types = Array.isArray(body?.business_type) ? body.business_type.filter((t) => KNOWN_BUSINESS_TYPES.includes(t)) : [];
    const payload = {
      business_type: types,
      certifying_body: body?.certifying_body || null,
      certification_number: body?.certification_number || null,
      certification_expiry: body?.certification_expiry || null,
      certificate_file_url: body?.certificate_file_url || null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await admin.from("diversity_profiles").select("id").eq("vendor_id", vendorId).maybeSingle();
    if (existing?.id) {
      // Any change by the vendor invalidates the prior verification
      const { error } = await admin.from("diversity_profiles")
        .update({ ...payload, verified: false, verified_at: null, verified_by: null })
        .eq("id", existing.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ id: existing.id, upserted: "updated" });
    }
    const { data: inserted, error } = await admin.from("diversity_profiles")
      .insert({ vendor_id: vendorId, ...payload })
      .select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: inserted?.id, upserted: "inserted" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
