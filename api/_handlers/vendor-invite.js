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
import crypto from "node:crypto";
import { demoEarlyExit } from "../_lib/demoGuard.js";

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inviteEmailHtml({ vendorName, inviteUrl }) {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="margin:0 0 8px">You've been invited</h2>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#334155">
      ${vendorName ? `${escapeHtml(vendorName)} — ` : ""}click the button below to set your password and access your Ring of Fire vendor portal account. This link expires in <b>72 hours</b>.
    </p>
    <p style="margin:0 0 18px">
      <a href="${inviteUrl}" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">Accept invite &amp; set password</a>
    </p>
    <p style="margin:0;font-size:12px;color:#64748b">If the button doesn't work, paste this link into your browser:<br>${inviteUrl}</p>
    <p style="margin:14px 0 0;font-size:12px;color:#94a3b8">If you weren't expecting this, you can ignore this email.</p>
  </div>`;
}

export default async function handler(req, res) {
  if (demoEarlyExit(req, res, "vendor-invite")) return;

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
  // Onboarding invite modal sends vendor_id (existing-vendor dropdown). Keep
  // legacy_blob_id (VendorManager) and vendor_name (typed/create) too.
  const vendor_id = String(body?.vendor_id || "").trim();
  const vendor_name = String(body?.vendor_name || "").trim();
  // Fall back to the request origin when the caller doesn't pass site_url.
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
  if (!vendor_id && !legacy_blob_id && !vendor_name) {
    return res.status(400).json({ error: "Select an existing vendor or enter a new vendor name" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!site_url || !/^https?:\/\//.test(site_url)) {
    return res.status(400).json({ error: "site_url must be an absolute http(s) URL" });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    // Resolve vendor: vendor_id (existing-vendor dropdown — precise) →
    // legacy_blob_id (VendorManager) → vendor_name (typed; create if no match).
    let vendor = null;
    if (vendor_id) {
      const { data, error: vErr } = await admin
        .from("vendors").select("id, name").eq("id", vendor_id).maybeSingle();
      if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
      if (!data) return res.status(404).json({ error: "Selected vendor not found." });
      vendor = data;
    } else if (legacy_blob_id) {
      const { data, error: vErr } = await admin
        .from("vendors").select("id, name").eq("legacy_blob_id", legacy_blob_id).maybeSingle();
      if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
      if (!data) {
        return res.status(404).json({
          error: "Vendor not found in vendors table. The mirror trigger may not have synced yet — try again in a moment.",
        });
      }
      vendor = data;
    } else {
      // vendor_name: match case-insensitively, else create a bare vendors row.
      const { data, error: vErr } = await admin
        .from("vendors").select("id, name").ilike("name", vendor_name).maybeSingle();
      if (vErr) return res.status(500).json({ error: "Vendor lookup failed: " + vErr.message });
      vendor = data;
      if (!vendor) {
        const { data: created, error: cErr } = await admin
          .from("vendors").insert({ name: vendor_name }).select("id, name").single();
        if (cErr) return res.status(500).json({ error: "Could not create vendor: " + cErr.message });
        vendor = created;
      }
    }

    // Custom invite flow (replaces admin.inviteUserByEmail). Supabase's built-in
    // invite link caps at 24h and 400s on re-invite of an existing email; this
    // flow is resend-safe and the link lasts 72h. We ensure the auth user
    // exists, then mint our own token + email it.
    let authId = null;
    const { data: createdUser } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createdUser?.user) {
      authId = createdUser.user.id;
    } else {
      // Already registered (resend) — resolve the existing user id via a
      // (discarded) magiclink generate.
      const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      authId = link?.user?.id || null;
      if (!authId) return res.status(500).json({ error: "Could not resolve the user for this email: " + (lErr?.message || "unknown") });
    }

    // Ensure the vendor_users link (idempotent — guard the re-invite case).
    const { data: existingLink } = await admin.from("vendor_users").select("id").eq("auth_id", authId).maybeSingle();
    if (!existingLink) {
      // status='pending' — they haven't accepted yet. accept-invite flips it to
      // 'active'. This keeps unaccepted invitees out of "Active vendor access".
      const { error: linkErr } = await admin.from("vendor_users").insert({
        auth_id: authId, vendor_id: vendor.id, display_name: display_name || null, role: "primary", status: "pending",
      });
      if (linkErr) return res.status(500).json({ error: "vendor_users link failed: " + linkErr.message });
    }

    // Mint a 72h token (store only the sha256 hash; raw token rides the link).
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const { error: tokErr } = await admin.from("vendor_invite_tokens").insert({
      vendor_id: vendor.id, auth_id: authId, email, display_name: display_name || null,
      token_hash: tokenHash, expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    });
    if (tokErr) return res.status(500).json({ error: "Could not create invite token: " + tokErr.message });

    const inviteUrl = `${site_url}/vendor/setup?invite=${rawToken}`;

    // Email via Resend. Manual-fallback: if no key, return the link to share.
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";
    if (!RESEND_KEY) {
      return res.status(200).json({
        ok: true, vendor_id: vendor.id, vendor_name: vendor.name, email, invite_url: inviteUrl,
        warning: "RESEND_API_KEY not set — email not sent. Share the invite_url with the vendor manually.",
      });
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [email],
        subject: "You've been invited to the Ring of Fire vendor portal",
        html: inviteEmailHtml({ vendorName: vendor.name, inviteUrl }),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Invite email failed to send: " + t.slice(0, 300), invite_url: inviteUrl });
    }

    // Always return invite_url so the UI can offer a "Copy link" manual fallback
    // (useful when email deliverability is flaky / the sending domain is unverified).
    return res.status(200).json({ ok: true, vendor_id: vendor.id, vendor_name: vendor.name, email, invite_url: inviteUrl });
  } catch (err) {
    return res.status(500).json({ error: "Invite handler error: " + (err?.message || String(err)) });
  }
}
