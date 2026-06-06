// api/vendor/accept-invite
//
// POST { token, password } — completes a custom 72h vendor-portal invite.
//
// Pairs with the invite handler (api/_handlers/vendor-invite.js), which mints a
// random token (sha256 hash stored in vendor_invite_tokens, raw token emailed in
// the /vendor/setup?invite=<token> link). Here we verify the token is unused +
// unexpired, set the auth user's password, mark the token used, and make sure
// the vendor_users link exists. The client then signs in with email+password.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const token = String(body?.token || "").trim();
  const password = String(body?.password || "");
  if (!token) return res.status(400).json({ error: "token is required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const token_hash = crypto.createHash("sha256").update(token).digest("hex");

  // Look up the token (unused). Don't leak whether it ever existed.
  const { data: row, error: tErr } = await admin
    .from("vendor_invite_tokens")
    .select("id, vendor_id, auth_id, email, display_name, expires_at, used_at")
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: "Token lookup failed: " + tErr.message });
  if (!row || row.used_at) return res.status(400).json({ error: "This invite link is invalid or has already been used." });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "This invite link has expired. Ask your Ring of Fire admin to resend." });
  }

  // Resolve the auth user id (stored at invite time; fall back to email lookup).
  let authId = row.auth_id;
  if (!authId) {
    const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: row.email });
    authId = link?.user?.id || null;
  }
  if (!authId) return res.status(500).json({ error: "Could not resolve the invited user account." });

  // Set the password + confirm the email so they can sign in immediately.
  const { error: uErr } = await admin.auth.admin.updateUserById(authId, { password, email_confirm: true });
  if (uErr) return res.status(500).json({ error: "Could not set password: " + uErr.message });

  // Mark the token used (best-effort — password is already set).
  await admin.from("vendor_invite_tokens").update({ used_at: new Date().toISOString() }).eq("id", row.id);

  // Ensure the vendor_users link exists and is now 'active' — they've accepted
  // (the invite created the link as 'pending'). This is what promotes them into
  // the "Active vendor access" list.
  const { data: existing } = await admin.from("vendor_users").select("id").eq("auth_id", authId).maybeSingle();
  const nowIso = new Date().toISOString();
  if (existing) {
    await admin.from("vendor_users").update({ status: "active", last_login: nowIso }).eq("id", existing.id);
  } else {
    await admin.from("vendor_users").insert({
      auth_id: authId,
      vendor_id: row.vendor_id,
      display_name: row.display_name || null,
      role: "primary",
      status: "active",
      last_login: nowIso,
    });
  }

  return res.status(200).json({ ok: true, email: row.email });
}
