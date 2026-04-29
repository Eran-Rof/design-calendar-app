// Notification digest flush cron.
//
// Runs every 15 minutes. Selects notification_digest_pending rows
// whose hour_bucket has closed (< current hour), groups by
// (recipient_email, event_type, hour_bucket), emits one digest email
// per group, and deletes the rows.
//
// CLAUDE.md spec: "if more than 3 notifications of the same type
// arrive within 1 hour for the same recipient and entity, batch them
// into a single digest email."
//
// Works against the queue populated by send-notification.js when it
// detects threshold breach. See migration
// 20260505000000_notification_digest_pending.sql.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDigestHtml({ event_type, items }) {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;vertical-align:top">
        <div style="font-weight:600;color:#111827">${escapeHtml(it.title ?? "Notification")}</div>
        ${it.body ? `<div style="color:#374151;margin-top:4px">${escapeHtml(it.body)}</div>` : ""}
        ${it.link ? `<div style="margin-top:6px"><a href="${escapeHtml(it.link)}" style="color:#3B82F6;text-decoration:none">View →</a></div>` : ""}
      </td>
    </tr>
  `).join("");
  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="padding:16px 20px;background:#111827;color:#ffffff">
      <div style="font-size:14px;letter-spacing:0.5px;text-transform:uppercase;opacity:0.7">Hourly digest</div>
      <div style="font-size:18px;font-weight:600;margin-top:4px">${escapeHtml(event_type)} — ${items.length} updates</div>
    </div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Cutoff = start of the current hour. Buckets strictly before this
  // are "closed" and safe to flush; the current hour is still
  // accepting new entries.
  const now = new Date();
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);
  const cutoffIso = currentHour.toISOString();

  // Fetch up to 500 closed-bucket rows per run. If there's more, the
  // next 15-min tick picks up the rest. Order by created_at so the
  // digest preserves chronological order within each rollup.
  const { data: rows, error: fetchErr } = await admin
    .from("notification_digest_pending")
    .select("id, recipient_email, event_type, hour_bucket, payload, vendor_id, entity_id, created_at")
    .lt("hour_bucket", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(500);
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!rows || rows.length === 0) {
    return res.status(200).json({ ok: true, buckets_flushed: 0, emails_sent: 0 });
  }

  // Group by (recipient_email, event_type, hour_bucket). Each group is
  // one digest email.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.recipient_email}|${r.event_type}|${r.hour_bucket}`;
    let bucket = groups.get(key);
    if (!bucket) { bucket = { ...r, ids: [], items: [] }; groups.set(key, bucket); }
    bucket.ids.push(r.id);
    bucket.items.push(r.payload || {});
  }

  let emailsSent = 0;
  let emailsFailed = 0;
  const errors = [];

  for (const [, group] of groups) {
    if (!RESEND_KEY) {
      // No email provider configured — log and delete (CLAUDE.md:
      // "queue + log, never throw, never fail silently"). Without
      // delete the rows would re-fire forever.
      console.warn("[digest-flush] RESEND_API_KEY missing — discarding digest", {
        recipient_email: group.recipient_email, event_type: group.event_type, count: group.items.length,
      });
      await admin.from("notification_digest_pending").delete().in("id", group.ids);
      continue;
    }
    const subject = `[Digest] ${group.event_type} — ${group.items.length} updates`;
    const html = renderDigestHtml({ event_type: group.event_type, items: group.items });
    try {
      const r = await fetch(RESEND_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: DEFAULT_FROM,
          to: [group.recipient_email],
          subject,
          html,
        }),
      });
      if (!r.ok) {
        emailsFailed++;
        const text = await r.text().catch(() => "");
        errors.push(`email ${group.recipient_email} (${group.event_type}): ${r.status} ${text.slice(0, 200)}`);
        // Don't delete the rows — they'll retry on the next flush. If
        // a digest sticks for many hours we can hand-clean.
        continue;
      }
      // Sent — clear the rows.
      const { error: delErr } = await admin
        .from("notification_digest_pending").delete().in("id", group.ids);
      if (delErr) {
        errors.push(`delete after send (${group.recipient_email}): ${delErr.message}`);
        continue;
      }
      emailsSent++;
    } catch (err) {
      emailsFailed++;
      errors.push(`exception ${group.recipient_email} (${group.event_type}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return res.status(200).json({
    ok: true,
    rows_scanned: rows.length,
    buckets_flushed: groups.size,
    emails_sent: emailsSent,
    emails_failed: emailsFailed,
    errors: errors.slice(0, 20),
  });
}
