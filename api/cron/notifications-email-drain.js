// api/cron/notifications-email-drain
//
// Drains pending notification_dispatches rows where channel='email'. Marks
// them sent or failed. Runs every 2 minutes per vercel.json.
//
// Sender selection (per arch sec 12.1):
//   - If RESEND_API_KEY is set → use Resend HTTP API (recommended path)
//   - Else if RESEND_FROM_EMAIL is set without key → fail loudly
//   - Else falls back to mock-send (records 'sent' but doesn't actually
//     hit SMTP). The mock branch is for dev/staging environments where
//     no sender is configured yet.
//
// Env vars:
//   RESEND_API_KEY        Resend API key (required for actual sending)
//   RESEND_FROM_EMAIL     e.g. "notifications@ringoffireclothing.com"
//   NOTIFICATIONS_DRAIN_LIMIT  Optional override (default 50)

import { createClient } from "@supabase/supabase-js";
import { drainPendingEmails } from "../_lib/notifications/index.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const limit = parseInt(process.env.NOTIFICATIONS_DRAIN_LIMIT || "50", 10);
  const send = buildSender();

  try {
    const out = await drainPendingEmails(admin, { limit, send });
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}

function buildSender() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (!apiKey) {
    // Mock sender - records 'sent' without actually emailing. For dev only.
    return async () => { /* no-op */ };
  }
  if (!fromEmail) {
    throw new Error("RESEND_FROM_EMAIL is required when RESEND_API_KEY is set");
  }

  // We need each recipient's email. The dispatch row carries recipient_user_id;
  // we look up the email via the auth.users table (service-role access).
  return async (dispatchRow) => {
    const ev = dispatchRow.event || {};
    const recipientId = dispatchRow.recipient_user_id;

    // Resolve recipient email
    const sbUrl = process.env.VITE_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const userResp = await fetch(
      `${sbUrl}/auth/v1/admin/users/${recipientId}`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } },
    );
    if (!userResp.ok) {
      throw new Error(`Failed to resolve user email: HTTP ${userResp.status}`);
    }
    const userJson = await userResp.json();
    const to = userJson.email || userJson.user?.email;
    if (!to) throw new Error(`No email on auth.user ${recipientId}`);

    const subjectPrefix = severityPrefix(ev.severity);
    const subject = `${subjectPrefix}${ev.subject || "Tangerine notification"}`;

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        text: ev.body || "",
      }),
    });
    if (!resendResp.ok) {
      const errBody = await resendResp.text().catch(() => "");
      throw new Error(`Resend send failed: ${resendResp.status} ${errBody.slice(0, 200)}`);
    }
  };
}

function severityPrefix(sev) {
  if (sev === "error") return "[Tangerine ERROR] ";
  if (sev === "warn") return "[Tangerine] ";
  return "";
}
