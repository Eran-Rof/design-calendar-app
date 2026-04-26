// api/vendor/payment-preferences
//
// GET  — the authenticated vendor's preferences (may be null).
// POST — upsert preferences.
//   body: { preferred_currency?, preferred_payment_method?, fx_handling? }

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";
import { validatePreferenceInput } from "../../../_lib/payments.js";

export const config = { maxDuration: 10 };

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
    const { data } = await admin.from("vendor_payment_preferences").select("*").eq("vendor_id", vendorId).maybeSingle();
    return res.status(200).json(data || null);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const errs = validatePreferenceInput(body || {});
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });

    const nowIso = new Date().toISOString();
    const payload = {
      preferred_currency: body?.preferred_currency || "USD",
      preferred_payment_method: body?.preferred_payment_method || "ach",
      fx_handling: body?.fx_handling || "pay_in_usd_vendor_absorbs",
      updated_at: nowIso,
    };

    const { data: existing } = await admin.from("vendor_payment_preferences").select("id").eq("vendor_id", vendorId).maybeSingle();
    if (existing?.id) {
      const { error } = await admin.from("vendor_payment_preferences").update(payload).eq("id", existing.id).eq("vendor_id", vendorId);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ id: existing.id, upserted: "updated" });
    }
    const { data: inserted, error } = await admin.from("vendor_payment_preferences")
      .insert({ vendor_id: vendorId, ...payload })
      .select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: inserted?.id, upserted: "inserted" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
