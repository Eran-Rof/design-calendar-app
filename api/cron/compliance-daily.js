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
//         compliance_expiring_soon notification — deduped per document
//         per expiry_date so we don't spam the vendor every day of the
//         window.
// Pass 3: for each newly-expired document (status='expired' with no
//         prior compliance_expired notification for this expiry_date),
//         notify the vendor primary user AND the internal compliance
//         team (INTERNAL_COMPLIANCE_EMAILS). One-shot per expiry.
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
    expiring_notifications_sent: 0,
    expiring_notifications_skipped_dedup: 0,
    expiring_notifications_skipped_no_recipient: 0,
    expired_notifications_sent: 0,
    expired_notifications_skipped_dedup: 0,
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
          title: `Action needed: ${typeName} expires on ${doc.expiry_date}`,
          body: `Your ${typeName} expires on ${doc.expiry_date} (in ${daysUntil} day${daysUntil === 1 ? "" : "s"}). Upload a renewed copy in the vendor portal before that date to stay compliant.`,
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
        result.expiring_notifications_sent++;
      } else {
        const body = await r.text().catch(() => "");
        if (r.status === 400 && body.includes("Could not resolve a recipient")) {
          result.expiring_notifications_skipped_no_recipient++;
        } else {
          result.errors.push({ doc_id: doc.id, status: r.status, body: body.slice(0, 200) });
        }
      }
    } catch (err) {
      result.errors.push({ doc_id: doc.id, error: err?.message || String(err) });
    }
  }

  // ── Pass 3: compliance_expired notifications ──────────────────────────
  let expiredDocs = [];
  try {
    const r = await admin
      .from("compliance_documents")
      .select("id, vendor_id, expiry_date, document_type_id, document_type:compliance_document_types(name), vendor:vendors(name)")
      .eq("status", "expired")
      .not("expiry_date", "is", null);
    if (r.error) throw r.error;
    expiredDocs = r.data || [];
  } catch (err) {
    result.errors.push({ pass: "expired_scan", error: err?.message || String(err) });
  }

  const internalEmails = (process.env.INTERNAL_COMPLIANCE_EMAILS || "")
    .split(",").map((e) => e.trim()).filter(Boolean);

  for (const doc of expiredDocs) {
    const typeName = doc.document_type?.name || "Document";
    const vendorName = doc.vendor?.name || "Vendor";

    // Dedup: one compliance_expired per document per expiry_date
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("event_type", "compliance_expired")
      .eq("metadata->>document_id", doc.id)
      .eq("metadata->>expiry_date", doc.expiry_date)
      .limit(1);
    if (existing && existing.length > 0) {
      result.expired_notifications_skipped_dedup++;
      continue;
    }

    const title = `Expired document: ${typeName} for ${vendorName}`;
    const body = `The ${typeName} for ${vendorName} expired on ${doc.expiry_date}. Please upload a renewed copy as soon as possible.`;
    const metadata = {
      document_id: doc.id,
      document_type: typeName,
      vendor_id: doc.vendor_id,
      vendor_name: vendorName,
      expiry_date: doc.expiry_date,
    };

    // Vendor primary user
    try {
      const r = await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "compliance_expired",
          title,
          body,
          link: "/vendor/compliance",
          metadata,
          recipient: { vendor_id: doc.vendor_id },
          dedupe_key: `compliance_expired_${doc.id}_${doc.expiry_date}_vendor`,
        }),
      });
      if (r.ok) result.expired_notifications_sent++;
    } catch (err) {
      result.errors.push({ doc_id: doc.id, error: `vendor notify: ${err?.message || err}` });
    }

    // Internal compliance team (per-email fan-out)
    for (const email of internalEmails) {
      try {
        const r = await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "compliance_expired",
            title,
            body,
            link: "/",
            metadata,
            recipient: { internal_id: "compliance_team", email },
            dedupe_key: `compliance_expired_${doc.id}_${doc.expiry_date}_${email}`,
          }),
        });
        if (r.ok) result.expired_notifications_sent++;
      } catch (err) {
        result.errors.push({ doc_id: doc.id, error: `internal notify: ${err?.message || err}` });
      }
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
