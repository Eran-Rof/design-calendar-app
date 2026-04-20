// api/cron/discount-offers-daily
//
// Daily discount-offer job. For each active entity:
//   1. Generate offers for newly-eligible invoices (fires discount_offer_made).
//   2. Expire offers past expires_at (fires discount_offer_expired).
//
// Scheduled at 11:00 UTC daily.

import { createClient } from "@supabase/supabase-js";
import { generateOffersForEntity, expireStaleOffers, CONSTANTS } from "../../_lib/discount-offers.js";

export const config = { maxDuration: 120 };

async function notify(origin, payload) {
  if (!origin) return;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* non-blocking */ }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const origin = req.headers.host ? `https://${req.headers.host}` : null;
  const result = { started_at: new Date().toISOString(), entities: 0, created: 0, expired: 0, errors: [] };

  const { data: entities } = await admin.from("entities").select("id").eq("status", "active");

  for (const e of entities || []) {
    try {
      const { created } = await generateOffersForEntity(admin, {
        entityId: e.id, targetAnnualizedPct: CONSTANTS.DEFAULT_TARGET_ANNUALIZED_PCT,
      });
      for (const o of created) {
        await notify(origin, {
          event_type: "discount_offer_made",
          title: `Early-payment offer: save $${Number(o.discount_amount).toFixed(2)}`,
          body: `You can be paid on ${o.early_payment_date} instead of ${o.original_due_date} in exchange for a ${Number(o.discount_pct).toFixed(2)}% discount.`,
          link: "/vendor/discount-offers",
          metadata: { offer_id: o.id, invoice_id: o.invoice_id },
          recipient: { vendor_id: o.vendor_id },
          dedupe_key: `discount_offer_made_${o.id}`,
          email: true,
        });
      }
      result.created += created.length;
      result.entities += 1;
    } catch (err) {
      result.errors.push({ entity_id: e.id, error: err?.message || String(err) });
    }
  }

  // Expire stale offers globally (one sweep)
  try {
    const expired = await expireStaleOffers(admin, {});
    for (const o of expired) {
      await notify(origin, {
        event_type: "discount_offer_expired",
        title: "Early-payment offer expired",
        body: "An early-payment offer from your buyer has expired without a response. Payment will proceed on the original due date.",
        link: "/vendor/discount-offers",
        metadata: { offer_id: o.id, invoice_id: o.invoice_id },
        recipient: { vendor_id: o.vendor_id },
        dedupe_key: `discount_offer_expired_${o.id}`,
        email: true,
      });
    }
    result.expired = expired.length;
  } catch (err) {
    result.errors.push({ stage: "expire", error: err?.message || String(err) });
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
