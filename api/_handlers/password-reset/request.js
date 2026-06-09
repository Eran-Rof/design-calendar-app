// api/password-reset/request — POST { subject_type, identifier, site_url }
//
// Forgot-password / first-time-set request for the two PASSWORD-BASED logins:
//   subject_type: 'plm'    — identifier = PLM username OR email (app_data users)
//   subject_type: 'vendor' — identifier = vendor email (Supabase Auth)
//
// Flow (mirrors api/_handlers/vendor-invite.js):
//   1. Resolve the account WITHOUT revealing whether it exists.
//   2. Mint a cryptographically-random token; store only its sha256 hash in
//      password_reset_tokens with a 1h expiry + subject id.
//   3. Email a reset link (raw token in ?reset_token=...) via Resend.
//   4. ALWAYS return a generic success — never leak account/email existence.
//
// Security: tokens hashed at rest, single-use + expiry enforced on confirm,
// per-account rate-limit, generic responses, no raw token / password logging.
// Service-role only (bypasses RLS on password_reset_tokens). Unauthenticated by
// nature — strict validation, no info leak.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { demoEarlyExit } from "../../_lib/demoGuard.js";

const TOKEN_TTL_MS = 60 * 60 * 1000;          // 1 hour
const RATE_WINDOW_MS = 15 * 60 * 1000;        // 15 min
const RATE_MAX = 5;                            // max requests per account per window

// Generic response — identical regardless of whether the account exists, so a
// caller can never probe for valid usernames/emails.
const GENERIC_OK = { ok: true, message: "If an account exists, a password reset email has been sent." };

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resetEmailHtml({ resetUrl, isVendor }) {
  const who = isVendor ? "Ring of Fire vendor portal" : "Ring of Fire PLM";
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="margin:0 0 8px">Reset your password</h2>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#334155">
      We received a request to set or reset the password for your ${who} account. Click the button below to choose a new password. This link expires in <b>1 hour</b> and can be used once.
    </p>
    <p style="margin:0 0 18px">
      <a href="${resetUrl}" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">Set a new password</a>
    </p>
    <p style="margin:0;font-size:12px;color:#64748b">If the button doesn't work, paste this link into your browser:<br>${resetUrl}</p>
    <p style="margin:14px 0 0;font-size:12px;color:#94a3b8">If you didn't request this, you can safely ignore this email — your password will not change.</p>
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
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const subjectType = String(body?.subject_type || "").trim();
  const identifier = String(body?.identifier || "").trim();
  if (subjectType !== "plm" && subjectType !== "vendor") {
    return res.status(400).json({ error: "Invalid subject_type" });
  }
  if (!identifier) {
    // Don't 200 here — a blank identifier is a client bug, not an enumeration probe.
    return res.status(400).json({ error: "identifier is required" });
  }

  const site_url = (() => {
    const s = String(body?.site_url || "").trim().replace(/\/$/, "");
    if (s && /^https?:\/\//.test(s)) return s;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0];
    return host ? `${proto}://${host}` : "";
  })();
  if (!site_url || !/^https?:\/\//.test(site_url)) {
    return res.status(400).json({ error: "site_url could not be resolved" });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Resolve the account. On ANY miss, fall through to the generic OK so the
  // response is indistinguishable from a hit.
  let subjectId = null;
  let email = null;
  let resetPath = null;

  try {
    if (subjectType === "plm") {
      // PLM users live in the app_data['users'] JSON blob. Match by username
      // (case-insensitive) OR email (case-insensitive). Requires an email on
      // file — admins populate emails in User Access; without one we can't send.
      const { data: rows } = await admin.from("app_data").select("value").eq("key", "users").maybeSingle();
      let users = [];
      try { users = JSON.parse(rows?.value || "[]"); } catch { users = []; }
      const needle = identifier.toLowerCase();
      const u = Array.isArray(users)
        ? users.find((x) =>
            (x?.username && String(x.username).toLowerCase() === needle) ||
            (x?.email && String(x.email).toLowerCase() === needle))
        : null;
      if (u && u.email) {
        subjectId = String(u.id);
        email = String(u.email).toLowerCase();
        resetPath = "/?reset_token=";
      }
    } else {
      // Vendor: identifier is the email. Confirm a vendor_users link exists for
      // the auth user before sending (don't reset arbitrary auth accounts).
      const candidateEmail = identifier.toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)) {
        const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: candidateEmail });
        const authId = link?.user?.id || null;
        if (authId) {
          const { data: vu } = await admin.from("vendor_users").select("id").eq("auth_id", authId).maybeSingle();
          if (vu) {
            subjectId = authId;
            email = candidateEmail;
            resetPath = "/vendor/reset?reset_token=";
          }
        }
      }
    }

    // No match → generic OK (no token minted, no email sent).
    if (!subjectId || !email) return res.status(200).json(GENERIC_OK);

    // Per-account rate-limit: cap recent requests in the window. Best-effort —
    // failure to count never blocks a legitimate reset.
    try {
      const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
      const { count } = await admin
        .from("password_reset_tokens")
        .select("id", { count: "exact", head: true })
        .eq("subject_type", subjectType)
        .eq("subject_id", subjectId)
        .gte("created_at", since);
      if (typeof count === "number" && count >= RATE_MAX) {
        // Silently swallow — still return generic OK so we don't reveal the
        // throttle (which would also confirm the account exists).
        return res.status(200).json(GENERIC_OK);
      }
    } catch { /* counting failed — proceed */ }

    // Mint a single-use token (store only the sha256 hash).
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const { error: insErr } = await admin.from("password_reset_tokens").insert({
      subject_type: subjectType,
      subject_id: subjectId,
      email,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    });
    if (insErr) {
      // Don't leak internal errors via timing/shape differences — generic OK.
      return res.status(200).json(GENERIC_OK);
    }

    const resetUrl = `${site_url}${resetPath}${rawToken}`;

    // Email via Resend. Outward action — only ever fires on a real request.
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";
    if (RESEND_KEY) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject: "Reset your Ring of Fire password",
          html: resetEmailHtml({ resetUrl, isVendor: subjectType === "vendor" }),
        }),
      });
      // Swallow send failures into the generic OK (never reveal account state).
      if (!r.ok) { await r.text().catch(() => ""); }
    }
    // No RESEND_KEY → still generic OK (manual-fallback: operator can re-run
    // with the key set). We deliberately do NOT echo the reset_url here because
    // this endpoint is unauthenticated and that would leak a valid token.

    return res.status(200).json(GENERIC_OK);
  } catch {
    // Any unexpected failure → generic OK (no enumeration via error shape).
    return res.status(200).json(GENERIC_OK);
  }
}
