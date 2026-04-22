// api/vendor-invite.js — Vercel Node.js Serverless Function
//
// Phase 1.3 — admin invites an external vendor user to the portal.
//
// Input (POST JSON):
//   { email, display_name, legacy_blob_id, site_url }
//
// Flow:
//   1. Look up vendors.id by legacy_blob_id (the id from app_data['vendors'])
//   2. supabase.auth.admin.inviteUserByEmail(email, { redirectTo: `${site_url}/vendor/setup` })
//   3. Insert into vendor_users (auth_id, vendor_id, display_name, role='primary')
//
// Requires SUPABASE_SERVICE_ROLE_KEY (server-side only, never VITE_-prefixed).
// The service-role client bypasses RLS, which is necessary for admin.inviteUserByEmail.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase not configured on server", urlPresent: !!SB_URL, keyPresent: !!SERVICE_KEY });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const display_name = String(body?.display_name || "").trim();
  const legacy_blob_id = String(body?.legacy_blob_id || "").trim();
  const site_url = String(body?.site_url || "").trim().replace(/\/$/, "");

  if (!email || !legacy_blob_id) {
    return res.status(400).json({ error: "email and legacy_blob_id are required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!site_url || !/^https?:\/\//.test(site_url)) {
    return res.status(400).json({ error: "site_url must be an absolute http(s) URL" });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const { data: vendor, error: vErr } = await admin
      .from("vendors")
      .select("id, name")
      .eq("legacy_blob_id", legacy_blob_id)
      .maybeSingle();
    if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
    if (!vendor) {
      return res.status(404).json({
        error: "Vendor not found in vendors table. The mirror trigger may not have synced yet — try again in a moment.",
      });
    }

    const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${site_url}/vendor/setup`,
    });
    if (invErr) {
      // "already been registered" → surface verbatim so admin can choose to
      // re-link (Phase 2) or send a password reset manually.
      return res.status(400).json({ error: invErr.message });
    }
    const authId = invited?.user?.id;
    if (!authId) return res.status(500).json({ error: "Invite succeeded but no auth user returned" });

    const { error: linkErr } = await admin
      .from("vendor_users")
      .insert({
        auth_id: authId,
        vendor_id: vendor.id,
        display_name: display_name || null,
        role: "primary",
      });
    if (linkErr) {
      // Invite succeeded but link failed — report both so the admin can clean up.
      return res.status(500).json({
        error: "Invite sent but vendor_users link failed: " + linkErr.message,
        auth_id: authId,
      });
    }

    return res.status(200).json({
      ok: true,
      auth_id: authId,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      email,
    });
  } catch (err) {
    return res.status(500).json({ error: "Invite handler error: " + (err?.message || String(err)) });
  }
}
