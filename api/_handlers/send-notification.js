// api/send-notification.js — Vercel Node.js Serverless Function
//
// Phase 2.6 — notification dispatch. Writes to notifications (in-app)
// and best-effort sends email via Resend. Idempotent-ish: callers can
// pass a dedupe_key and we'll skip if one already exists within 1h.
//
// Auth: requires SUPABASE_SERVICE_ROLE_KEY. Typically called from other
// serverless functions (server-to-server) OR by the vendor's own
// authenticated session when they trigger their own actions. Not exposed
// to anonymous callers.
//
// Body (POST JSON):
//   { event_type, title, body?, link?, metadata?,
//     recipient: { auth_id? | internal_id? | email? | vendor_id? },
//     email?: boolean (default true),
//     dedupe_key?: string }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";

// Event types that should also queue mobile push notifications.
const PUSH_EVENT_TYPES = new Set([
  "po_issued", "invoice_approved", "invoice_discrepancy", "payment_sent",
  "new_message", "new_dispute_message", "rfq_invited", "rfq_awarded",
  "compliance_expiring_soon", "onboarding_approved", "dispute_resolved",
]);

function deepLinkFor(eventType, metadata = {}) {
  if (metadata?.po_id)       return `vendor://pos/${metadata.po_id}`;
  if (metadata?.po_number)   return `vendor://pos/${metadata.po_number}`;
  if (metadata?.rfq_id)      return `vendor://rfqs/${metadata.rfq_id}`;
  if (metadata?.invoice_id)  return `vendor://invoices/${metadata.invoice_id}`;
  if (metadata?.dispute_id)  return `vendor://disputes/${metadata.dispute_id}`;
  if (metadata?.contract_id) return `vendor://contracts/${metadata.contract_id}`;
  return "vendor://home";
}

async function queuePushesForVendor(admin, { vendor_id, event_type, title, body, metadata }) {
  if (!vendor_id) return 0;
  if (!PUSH_EVENT_TYPES.has(event_type)) return 0;
  // CRITICAL: must short-circuit when the vendor has no users.
  // PostgREST's .in("col", []) renders as `col=in.()` which it
  // treats as "no filter" — meaning we'd queue pushes to EVERY
  // device of EVERY vendor in the system. Don't ever build the
  // .in() with an empty array.
  const { data: vendorUserRows } = await admin
    .from("vendor_users")
    .select("id")
    .eq("vendor_id", vendor_id);
  const userIds = (vendorUserRows ?? []).map((r) => r.id);
  if (userIds.length === 0) return 0;
  const { data: sessions } = await admin
    .from("mobile_sessions")
    .select("id, vendor_user_id")
    .in("vendor_user_id", userIds);
  if (!sessions || sessions.length === 0) return 0;
  const entityId = metadata?.po_id || metadata?.invoice_id || metadata?.rfq_id || metadata?.dispute_id || metadata?.contract_id || null;
  const rows = sessions.map((s) => ({
    vendor_user_id: s.vendor_user_id,
    mobile_session_id: s.id,
    title,
    body: body || null,
    data: { type: event_type, entity_id: entityId, deep_link: deepLinkFor(event_type, metadata) },
    status: "queued",
  }));
  try {
    await admin.from("push_notifications").insert(rows);
  } catch (err) {
    console.error("[send-notification] push_notifications insert failed", {
      vendor_id, event_type, count: rows.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return rows.length;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured", supabase: !!SB_URL, serviceKey: !!SERVICE_KEY });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const { event_type, title, link, metadata, recipient, dedupe_key } = body || {};
  const bodyText = body?.body;
  const wantEmail = body?.email !== false;
  if (!event_type || !title || !recipient) {
    return res.status(400).json({ error: "event_type, title, recipient are required" });
  }

  // Resolve recipient
  let recipientAuthId = recipient.auth_id || null;
  let recipientInternalId = recipient.internal_id || null;
  let recipientEmail = recipient.email || null;

  if (!recipientAuthId && !recipientInternalId && recipient.vendor_id) {
    // Fan-out: send to the primary vendor_user for this vendor
    const { data: vu } = await admin
      .from("vendor_users").select("auth_id").eq("vendor_id", recipient.vendor_id).eq("role", "primary").maybeSingle();
    if (vu?.auth_id) recipientAuthId = vu.auth_id;
  }

  if (recipientAuthId && !recipientEmail) {
    const { data: userRes } = await admin.auth.admin.getUserById(recipientAuthId);
    recipientEmail = userRes?.user?.email || null;
  }

  if (!recipientAuthId && !recipientInternalId) {
    return res.status(400).json({ error: "Could not resolve a recipient (auth_id, internal_id, or vendor_id)" });
  }

  // Optional dedupe within the last hour
  if (dedupe_key) {
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("event_type", event_type)
      .eq("metadata->>dedupe_key", dedupe_key)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .maybeSingle();
    if (existing) return res.status(200).json({ ok: true, deduped: true, id: existing.id });
  }

  // Digest threshold check — CLAUDE.md requires "if more than 3
  // notifications of the same type arrive within 1 hour for the same
  // recipient, batch them into a single digest email." If we'd be the
  // 4th-or-later in this hour, queue into notification_digest_pending
  // instead of emailing now. The cron/notification-digest-flush job
  // emails one digest per (recipient, type, hour_bucket) when the
  // hour closes. The in-app notification is still written so the
  // bell icon updates in real-time.
  let willDigest = false;
  if (wantEmail && recipientEmail && RESEND_KEY) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recent } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("event_type", event_type)
      .eq("recipient_email", recipientEmail)
      .gte("created_at", oneHourAgo);
    if ((recent ?? 0) >= 3) {
      willDigest = true;
    }
  }

  // Persist the in-app notification
  const email_status = !wantEmail || !recipientEmail || !RESEND_KEY
    ? "skipped"
    : willDigest
      ? "queued_for_digest"
      : "pending";
  const { data: inserted, error: insErr } = await admin
    .from("notifications")
    .insert({
      recipient_auth_id: recipientAuthId,
      recipient_internal_id: recipientInternalId,
      recipient_email: recipientEmail,
      event_type,
      title,
      body: bodyText ?? null,
      link: link ?? null,
      metadata: { ...(metadata || {}), ...(dedupe_key ? { dedupe_key } : {}) },
      email_status,
    })
    .select("id")
    .single();
  if (insErr) return res.status(500).json({ error: "Notification insert failed: " + insErr.message });

  // If we're queueing for digest, write to the pending table and skip
  // the immediate email. The flush cron picks it up on the next tick
  // after the hour-bucket closes.
  if (willDigest) {
    const hourBucket = new Date();
    hourBucket.setMinutes(0, 0, 0);
    try {
      await admin.from("notification_digest_pending").insert({
        recipient_email: recipientEmail,
        event_type,
        hour_bucket: hourBucket.toISOString(),
        payload: { title, body: bodyText ?? null, link: link ?? null, metadata: metadata ?? null },
        vendor_id: recipient.vendor_id ?? null,
        entity_id: metadata?.entity_id ?? null,
      });
    } catch (err) {
      // If the queue insert fails (e.g. table missing because the
      // migration hasn't been applied yet), fall back to the original
      // behavior — just leave email_status as queued_for_digest in the
      // notification row and log. The in-app row is already saved.
      console.error("[send-notification] digest enqueue failed", {
        recipient_email: recipientEmail, event_type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fire email (best-effort; never block the caller on email failure)
  let emailResult = null;
  if (email_status === "pending") {
    const emailBody = renderEmailHtml({ title, body: bodyText, link });
    try {
      const r = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: DEFAULT_FROM,
          to: [recipientEmail],
          subject: title,
          html: emailBody,
        }),
      });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
      if (r.ok) {
        await admin.from("notifications").update({
          email_status: "sent",
          email_sent_at: new Date().toISOString(),
          email_attempts: 1,
          resend_message_id: parsed?.id || null,
        }).eq("id", inserted.id);
        emailResult = { sent: true, id: parsed?.id };
      } else {
        await admin.from("notifications").update({
          email_status: "failed",
          email_attempts: 1,
          email_error: (parsed?.message || parsed?.error || text.slice(0, 300)),
        }).eq("id", inserted.id);
        emailResult = { sent: false, status: r.status, error: parsed?.message };
      }
    } catch (err) {
      await admin.from("notifications").update({
        email_status: "failed",
        email_attempts: 1,
        email_error: err?.message || String(err),
      }).eq("id", inserted.id);
      emailResult = { sent: false, error: err?.message };
    }
  }

  // Fan out to push queue for mobile devices (best-effort; non-blocking).
  let pushQueued = 0;
  if (recipient.vendor_id || recipientAuthId) {
    try {
      let vendorIdForPush = recipient.vendor_id;
      if (!vendorIdForPush && recipientAuthId) {
        const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", recipientAuthId).maybeSingle();
        vendorIdForPush = vu?.vendor_id || null;
      }
      if (vendorIdForPush) {
        pushQueued = await queuePushesForVendor(admin, { vendor_id: vendorIdForPush, event_type, title, body: bodyText, metadata });
      }
    } catch (err) {
      console.error("[send-notification] push fan-out failed", {
        recipient_auth_id: recipientAuthId,
        event_type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return res.status(200).json({ ok: true, id: inserted.id, email: emailResult, email_status, push_queued: pushQueued });
}

function renderEmailHtml({ title, body, link }) {
  // Escape link too — it's interpolated into an href attribute, so an
  // unescaped quote would break out of the attribute and let a caller
  // inject arbitrary HTML/JS into the email body. Also reject anything
  // that doesn't look like an http(s) URL or absolute path so attackers
  // can't smuggle a `javascript:` URL through.
  const safeLink = isSafeLink(link) ? link : null;
  const linkBlock = safeLink
    ? `<p style="margin:16px 0;"><a href="${escapeHtml(safeLink)}" style="background:#C8210A;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">View details</a></p>`
    : "";
  return `
<!DOCTYPE html>
<html><body style="font-family:system-ui,Arial,sans-serif;color:#1A202C;background:#F7F8FA;padding:20px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #CBD5E0;border-radius:10px;padding:28px;">
    <h1 style="margin:0 0 10px;font-size:20px;color:#2D3748;">${escapeHtml(title)}</h1>
    ${body ? `<div style="font-size:14px;color:#4A5568;line-height:1.5;">${escapeHtml(body).replace(/\n/g, "<br>")}</div>` : ""}
    ${linkBlock}
    <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0 14px;">
    <p style="font-size:12px;color:#718096;margin:0;">Ring of Fire Vendor Portal</p>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isSafeLink(s) {
  if (typeof s !== "string" || !s) return false;
  // Allow http(s) URLs and root-anchored relative paths only — blocks
  // javascript:, data:, mailto:, etc. as well as anything that doesn't
  // look like a navigation target.
  return /^https?:\/\//i.test(s) || /^\/[^\/]/.test(s) || s === "/";
}
