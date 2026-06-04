// api/internal/vendor-invites
//
// GET — vendor-portal invitations, one row per (vendor, email) = the latest
// token, with a derived status:
//   pending  — latest token unused and not yet expired
//   expired  — latest token unused and past its 72h window
//   accepted — the vendor used an invite token (set their password)
//
// Optional ?status=outstanding returns only pending + expired (the ones that
// need a resend). Backs the "Outstanding invitations" panel + Resend button.
//
// POST { invite_id, email, display_name? } — EDIT a still-pending invitation's
//   email (e.g. it was typed wrong) and RESEND a fresh 72h invite link to the
//   corrected address. Only invitations that have NOT been accepted are
//   editable (rejected otherwise). The token row's email/display_name are
//   updated, a fresh token is minted + emailed via Resend, and the new email
//   becomes the active target. Internal staff only (authenticateInternalCaller).

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "POST") {
    // Mutating action — gate on the internal token (matches sibling
    // internal/* mutating handlers). GET stays open to keep the existing
    // list panel working as before.
    const auth = authenticateInternalCaller(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    return doEditAndResend(req, res, admin);
  }

  return doList(req, res, admin);
}

async function doList(req, res, admin) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const statusFilter = (url.searchParams.get("status") || "").trim();

  const { data: rows, error } = await admin
    .from("vendor_invite_tokens")
    .select("id, vendor_id, email, display_name, expires_at, used_at, created_at, vendor:vendors(id, name)")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Collapse to one entry per (vendor_id, lower(email)). Rows are newest-first,
  // so the first seen per key is the latest token; aggregate ever_accepted.
  const byKey = new Map();
  for (const r of rows || []) {
    const key = `${r.vendor_id}|${(r.email || "").toLowerCase()}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        id: r.id, vendor_id: r.vendor_id, vendor_name: r.vendor?.name || null,
        email: r.email, display_name: r.display_name,
        sent_at: r.created_at, expires_at: r.expires_at, ever_accepted: false,
      };
      byKey.set(key, g);
    }
    if (r.used_at) g.ever_accepted = true;
  }

  const now = Date.now();
  let out = [...byKey.values()].map((g) => ({
    id: g.id,
    vendor_id: g.vendor_id,
    vendor_name: g.vendor_name,
    email: g.email,
    display_name: g.display_name,
    sent_at: g.sent_at,
    expires_at: g.expires_at,
    status: g.ever_accepted ? "accepted" : (new Date(g.expires_at).getTime() > now ? "pending" : "expired"),
  }));

  if (statusFilter === "outstanding") out = out.filter((x) => x.status !== "accepted");
  else if (statusFilter) out = out.filter((x) => x.status === statusFilter);

  // Outstanding first (expired, then pending), accepted last; newest-first within.
  const rank = { expired: 0, pending: 1, accepted: 2 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (new Date(b.sent_at) - new Date(a.sent_at)));

  return res.status(200).json(out);
}

// Edit a still-pending invitation's email (+ optional contact name) and resend
// a fresh 72h invite link to the corrected address. Self-contained re-mint:
// mirrors the vendor-invite.js send flow so the new email gets a valid link.
async function doEditAndResend(req, res, admin) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }

  const inviteId = String(body?.invite_id || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const hasDisplayName = body?.display_name !== undefined;
  const displayName = hasDisplayName ? String(body?.display_name || "").trim() : null;

  if (!inviteId) return res.status(400).json({ error: "invite_id is required" });
  if (!email) return res.status(400).json({ error: "Email is required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email" });

  const site_url = (() => {
    const s = String(body?.site_url || "").trim().replace(/\/$/, "");
    if (s && /^https?:\/\//.test(s)) return s;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0];
    return host ? `${proto}://${host}` : "";
  })();
  if (!site_url || !/^https?:\/\//.test(site_url)) {
    return res.status(400).json({ error: "Could not resolve the portal URL for the invite link" });
  }

  // Resolve the invite row (the latest token for that vendor+email is what the
  // list surfaces; we edit by its id).
  const { data: invite, error: iErr } = await admin
    .from("vendor_invite_tokens")
    .select("id, vendor_id, auth_id, email, display_name, used_at, vendor:vendors(id, name)")
    .eq("id", inviteId)
    .maybeSingle();
  if (iErr) return res.status(500).json({ error: "Invite lookup failed: " + iErr.message });
  if (!invite) return res.status(404).json({ error: "Invitation not found" });

  // Pending-only guard: never edit an already-accepted invite. Check BOTH this
  // row and any other token for the same (vendor, original email) — once the
  // vendor has accepted, editing the email would be meaningless/confusing.
  if (invite.used_at) {
    return res.status(409).json({ error: "This invitation has already been accepted and cannot be edited." });
  }
  const { data: siblings } = await admin
    .from("vendor_invite_tokens")
    .select("used_at")
    .eq("vendor_id", invite.vendor_id)
    .ilike("email", invite.email || "");
  if ((siblings || []).some((s) => s.used_at)) {
    return res.status(409).json({ error: "This invitation has already been accepted and cannot be edited." });
  }

  const vendor = invite.vendor || null;
  const newDisplayName = hasDisplayName ? (displayName || null) : (invite.display_name || null);

  // Ensure an auth user exists for the NEW email (createUser is idempotent-ish:
  // it errors if already registered, in which case we resolve the existing id).
  let authId = invite.auth_id || null;
  const { data: createdUser } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createdUser?.user) {
    authId = createdUser.user.id;
  } else {
    const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    authId = link?.user?.id || authId;
    if (!authId) return res.status(500).json({ error: "Could not resolve the user for this email: " + (lErr?.message || "unknown") });
  }

  // Keep the vendor_users link pointed at the (possibly new) auth user.
  const { data: existingLink } = await admin
    .from("vendor_users").select("id").eq("auth_id", authId).maybeSingle();
  if (!existingLink) {
    const { error: linkErr } = await admin.from("vendor_users").insert({
      auth_id: authId, vendor_id: invite.vendor_id, display_name: newDisplayName, role: "primary",
    });
    if (linkErr) return res.status(500).json({ error: "vendor_users link failed: " + linkErr.message });
  } else if (hasDisplayName) {
    await admin.from("vendor_users").update({ display_name: newDisplayName }).eq("id", existingLink.id);
  }

  // Update the existing invite row to the corrected email/name and re-mint a
  // fresh 72h token on it (so the OLD email's link is no longer the active
  // target — the active token now hashes the link we email below).
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const { data: updated, error: uErr } = await admin
    .from("vendor_invite_tokens")
    .update({
      email,
      display_name: newDisplayName,
      auth_id: authId,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      used_at: null,
    })
    .eq("id", inviteId)
    .select("id, vendor_id, email, display_name, expires_at, created_at")
    .single();
  if (uErr) return res.status(500).json({ error: "Could not update invitation: " + uErr.message });

  const inviteUrl = `${site_url}/vendor/setup?invite=${rawToken}`;

  const result = {
    ok: true,
    invite: {
      id: updated.id,
      vendor_id: updated.vendor_id,
      vendor_name: vendor?.name || null,
      email: updated.email,
      display_name: updated.display_name,
      sent_at: updated.created_at,
      expires_at: updated.expires_at,
      status: "pending",
    },
  };

  // Email via Resend. Manual-fallback: if no key, return the link to share.
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";
  if (!RESEND_KEY) {
    return res.status(200).json({
      ...result, invite_url: inviteUrl,
      warning: "Email updated, but RESEND_API_KEY is not set — email not sent. Share the invite_url with the vendor manually.",
    });
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [email],
      subject: "You've been invited to the Ring of Fire vendor portal",
      html: inviteEmailHtml({ vendorName: vendor?.name || null, inviteUrl }),
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return res.status(502).json({ ...result, error: "Invitation updated, but the email failed to send: " + t.slice(0, 300), invite_url: inviteUrl });
  }

  return res.status(200).json(result);
}
