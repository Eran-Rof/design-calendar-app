// api/cron/contracts-daily.js
//
// Daily contract housekeeping. Runs at the schedule defined in
// vercel.json; also invokable manually (protected by CRON_SECRET).
//
// Pass 1: find signed contracts whose end_date is within the next 30
//         days → fire contract_expiring_soon to the vendor primary
//         user AND to the internal_owner / INTERNAL_CONTRACT_EMAILS.
//         Deduped per (contract_id, end_date).
// Pass 2: find signed contracts whose end_date is past → flip status
//         to 'expired' AND fire contract_expired to the same list.
//         Deduped same way.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

const EXPIRING_WINDOW_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && req.headers.authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const result = {
    started_at: new Date().toISOString(),
    expiring_soon: { candidates: 0, notifications_sent: 0, skipped_dedup: 0 },
    expired:       { flipped: 0, notifications_sent: 0, skipped_dedup: 0 },
    errors: [],
  };

  const origin = `https://${req.headers.host}`;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);
  const cutoffIso = new Date(today.getTime() + EXPIRING_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  // Fan-out internal recipients: env + internal_owner if it looks like an email
  const baseInternalEmails = (process.env.INTERNAL_CONTRACT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
    .split(",").map((e) => e.trim()).filter(Boolean);

  // ── Pass 1: expiring soon ────────────────────────────────────────────
  try {
    const { data: expiringSoon, error } = await admin
      .from("contracts")
      .select("id, vendor_id, title, contract_type, end_date, internal_owner, vendor:vendors(name)")
      .eq("status", "signed")
      .not("end_date", "is", null)
      .gte("end_date", todayIso)
      .lte("end_date", cutoffIso);
    if (error) throw error;
    result.expiring_soon.candidates = (expiringSoon || []).length;

    for (const c of expiringSoon || []) {
      // Dedup per (contract_id, end_date)
      const { data: existing } = await admin
        .from("notifications")
        .select("id")
        .eq("event_type", "contract_expiring_soon")
        .eq("metadata->>contract_id", c.id)
        .eq("metadata->>end_date", c.end_date)
        .limit(1);
      if (existing && existing.length > 0) {
        result.expiring_soon.skipped_dedup++;
        continue;
      }

      const vendorName = c.vendor?.name || "Vendor";
      const daysUntil = Math.round((new Date(c.end_date + "T00:00:00").getTime() - today.getTime()) / 86_400_000);
      const title = `Contract expiring in ${daysUntil} days: ${c.title}`;
      const body = `The ${c.contract_type.replace(/_/g, " ")} '${c.title}' with ${vendorName} expires on ${c.end_date}.`;
      const metadata = { contract_id: c.id, vendor_id: c.vendor_id, end_date: c.end_date, days_until: daysUntil };

      // Vendor primary user
      try {
        const r = await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "contract_expiring_soon",
            title, body,
            link: "/vendor/contracts",
            metadata,
            recipient: { vendor_id: c.vendor_id },
            dedupe_key: `contract_expiring_${c.id}_${c.end_date}_vendor`,
            email: true,
          }),
        });
        if (r.ok) result.expiring_soon.notifications_sent++;
      } catch (err) {
        result.errors.push({ contract_id: c.id, error: `vendor notify: ${err?.message || err}` });
      }

      // Internal recipients: env list + internal_owner if email-shaped
      const internalEmails = new Set(baseInternalEmails);
      if (c.internal_owner && c.internal_owner.includes("@")) internalEmails.add(c.internal_owner);
      for (const email of internalEmails) {
        try {
          const r = await fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "contract_expiring_soon",
              title, body,
              link: "/",
              metadata,
              recipient: { internal_id: "contracts_team", email },
              dedupe_key: `contract_expiring_${c.id}_${c.end_date}_${email}`,
              email: true,
            }),
          });
          if (r.ok) result.expiring_soon.notifications_sent++;
        } catch (err) {
          result.errors.push({ contract_id: c.id, error: `internal notify: ${err?.message || err}` });
        }
      }
    }
  } catch (err) {
    result.errors.push({ pass: "expiring_soon", error: err?.message || String(err) });
  }

  // ── Pass 2: flip to expired + notify ──────────────────────────────────
  try {
    // Find past-due signed contracts first so we can notify about each one
    const { data: pastDue, error } = await admin
      .from("contracts")
      .select("id, vendor_id, title, contract_type, end_date, internal_owner, vendor:vendors(name)")
      .eq("status", "signed")
      .not("end_date", "is", null)
      .lt("end_date", todayIso);
    if (error) throw error;

    if ((pastDue || []).length > 0) {
      const ids = pastDue.map((c) => c.id);
      const { error: updErr } = await admin
        .from("contracts")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .in("id", ids);
      if (updErr) throw updErr;
      result.expired.flipped = ids.length;
    }

    for (const c of pastDue || []) {
      const { data: existing } = await admin
        .from("notifications")
        .select("id")
        .eq("event_type", "contract_expired")
        .eq("metadata->>contract_id", c.id)
        .eq("metadata->>end_date", c.end_date)
        .limit(1);
      if (existing && existing.length > 0) {
        result.expired.skipped_dedup++;
        continue;
      }

      const vendorName = c.vendor?.name || "Vendor";
      const title = `Contract expired: ${c.title}`;
      const body = `The ${c.contract_type.replace(/_/g, " ")} '${c.title}' with ${vendorName} expired on ${c.end_date}. Please initiate a renewal or amendment if this program is continuing.`;
      const metadata = { contract_id: c.id, vendor_id: c.vendor_id, end_date: c.end_date };

      // Vendor
      try {
        const r = await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "contract_expired",
            title, body,
            link: "/vendor/contracts",
            metadata,
            recipient: { vendor_id: c.vendor_id },
            dedupe_key: `contract_expired_${c.id}_${c.end_date}_vendor`,
            email: true,
          }),
        });
        if (r.ok) result.expired.notifications_sent++;
      } catch (err) {
        result.errors.push({ contract_id: c.id, error: `vendor notify: ${err?.message || err}` });
      }

      // Internal
      const internalEmails = new Set(baseInternalEmails);
      if (c.internal_owner && c.internal_owner.includes("@")) internalEmails.add(c.internal_owner);
      for (const email of internalEmails) {
        try {
          const r = await fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "contract_expired",
              title, body,
              link: "/",
              metadata,
              recipient: { internal_id: "contracts_team", email },
              dedupe_key: `contract_expired_${c.id}_${c.end_date}_${email}`,
              email: true,
            }),
          });
          if (r.ok) result.expired.notifications_sent++;
        } catch (err) {
          result.errors.push({ contract_id: c.id, error: `internal notify: ${err?.message || err}` });
        }
      }
    }
  } catch (err) {
    result.errors.push({ pass: "expired", error: err?.message || String(err) });
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
