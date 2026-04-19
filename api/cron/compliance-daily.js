// api/cron/compliance-daily.js
//
// Daily compliance housekeeping. Vercel cron runs this at the schedule
// set in vercel.json; it can also be invoked manually (protected by
// CRON_SECRET when set).
//
// Pass 1: flip status approved|pending_review -> expired on rows whose
//         expiry_date < today (via mark_expired_compliance_docs()).
// Pass 2: for each approved document expiring within the doc-type's
//         reminder_days_before window, emit one
//         compliance_expiring_soon notification — deduped so we don't
//         spam the vendor every day of the window.
//
// Auth: Vercel cron includes `Authorization: Bearer ${CRON_SECRET}`
// automatically. If CRON_SECRET is unset, the endpoint is open (useful
// for manual dry-runs in staging).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const result = {
    started_at: new Date().toISOString(),
    expired_count: 0,
    expiring_candidates: 0,
    notifications_sent: 0,
    notifications_skipped_dedup: 0,
    notifications_skipped_no_recipient: 0,
    errors: [],
  };

  // ── Pass 1: mark expired ─────────────────────────────────────────────
  try {
    const { data, error } = await admin.rpc("mark_expired_compliance_docs");
    if (error) result.errors.push({ pass: "expire", error: error.message });
    else result.expired_count = typeof data === "number" ? data : 0;
  } catch (err) {
    result.errors.push({ pass: "expire", error: err?.message || String(err) });
  }

  // ── Pass 2: find approved docs in the reminder window ────────────────
  let candidates = [];
  try {
    const r = await admin
      .from("compliance_documents")
      .select("id, vendor_id, expiry_date, document_type_id, document_type:compliance_document_types(name, reminder_days_before)")
      .eq("status", "approved")
      .not("expiry_date", "is", null);
    if (r.error) throw r.error;
    candidates = r.data || [];
  } catch (err) {
    result.errors.push({ pass: "scan", error: err?.message || String(err) });
    return res.status(200).json(result);
  }

  const now = Date.now();
  const origin = `https://${req.headers.host}`;

  for (const doc of candidates) {
    const reminderDays = doc.document_type?.reminder_days_before ?? 30;
    const typeName = doc.document_type?.name || "Document";
    const expMs = new Date(doc.expiry_date + "T00:00:00").getTime();
    if (Number.isNaN(expMs)) continue;
    const daysUntil = Math.ceil((expMs - now) / 86_400_000);
    if (daysUntil <= 0 || daysUntil > reminderDays) continue;

    result.expiring_candidates++;

    // Dedup: skip if any notification of this type already exists for this doc
    // with the current expiry_date (resets if the doc is renewed).
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("event_type", "compliance_expiring_soon")
      .eq("metadata->>document_id", doc.id)
      .eq("metadata->>expiry_date", doc.expiry_date)
      .limit(1);
    if (existing && existing.length > 0) {
      result.notifications_skipped_dedup++;
      continue;
    }

    try {
      const r = await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "compliance_expiring_soon",
          title: `${typeName} expires in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
          body: `Your ${typeName} expires on ${doc.expiry_date}. Upload a renewed copy in the vendor portal before that date to stay compliant.`,
          link: "/vendor/compliance",
          metadata: {
            document_id: doc.id,
            document_type: typeName,
            expiry_date: doc.expiry_date,
            days_until: daysUntil,
          },
          recipient: { vendor_id: doc.vendor_id },
          dedupe_key: `compliance_expiring_${doc.id}_${doc.expiry_date}`,
        }),
      });
      if (r.ok) {
        result.notifications_sent++;
      } else {
        const body = await r.text().catch(() => "");
        if (r.status === 400 && body.includes("Could not resolve a recipient")) {
          result.notifications_skipped_no_recipient++;
        } else {
          result.errors.push({ doc_id: doc.id, status: r.status, body: body.slice(0, 200) });
        }
      }
    } catch (err) {
      result.errors.push({ doc_id: doc.id, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
