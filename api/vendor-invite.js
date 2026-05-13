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
  const vendor_name = String(body?.vendor_name || "").trim();
  // Fall back to current origin for callers that don't pass site_url —
  // the Onboarding panel in TandA doesn't know the absolute URL.
  const site_url = (() => {
    const s = String(body?.site_url || "").trim().replace(/\/$/, "");
    if (s && /^https?:\/\//.test(s)) return s;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0];
    return host ? `${proto}://${host}` : "";
  })();

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }
  if (!legacy_blob_id && !vendor_name) {
    return res.status(400).json({ error: "Either legacy_blob_id or vendor_name is required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!site_url || !/^https?:\/\//.test(site_url)) {
    return res.status(400).json({ error: "site_url must be an absolute http(s) URL" });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    // Resolve vendor by legacy_blob_id (preferred) OR vendor_name
    // (Onboarding flow that doesn't know the blob id). If nothing
    // matches and vendor_name was provided, create a new vendors row.
    let vendor = null;
    if (legacy_blob_id) {
      const { data, error: vErr } = await admin
        .from("vendors").select("id, name")
        .eq("legacy_blob_id", legacy_blob_id).maybeSingle();
      if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
      vendor = data;
    } else if (vendor_name) {
      const { data, error: vErr } = await admin
        .from("vendors").select("id, name")
        .ilike("name", vendor_name).maybeSingle();
      if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
      vendor = data;
      if (!vendor) {
        const { data: created, error: cErr } = await admin
          .from("vendors").insert({ name: vendor_name }).select("id, name").single();
        if (cErr) return res.status(500).json({ error: "Could not create vendor: " + cErr.message });
        vendor = created;
      }
    }
    if (!vendor) {
      return res.status(404).json({
        error: "Vendor not found and no vendor_name provided to create one.",
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
