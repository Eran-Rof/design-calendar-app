// api/internal/discount-offers/generate
//
// POST — manual offer generation.
//   body: { entity_id?, invoice_ids?: [], early_payment_date? (ignored — computed),
//           discount_pct? (override), target_annualized_pct? }
// Returns: { created, skipped }

import { createClient } from "@supabase/supabase-js";
import { generateOffersForEntity, CONSTANTS } from "../../../_lib/discount-offers.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const entityId = body?.entity_id || req.headers["x-entity-id"];
  if (!entityId) return res.status(400).json({ error: "entity_id required" });

  const targetAnnualizedPct = body?.target_annualized_pct
    ? Number(body.target_annualized_pct)
    : CONSTANTS.DEFAULT_TARGET_ANNUALIZED_PCT;

  const { created, skipped } = await generateOffersForEntity(admin, {
    entityId,
    invoiceIds: body?.invoice_ids,
    targetAnnualizedPct,
    discountPctOverride: body?.discount_pct ?? null,
  });

  // Fire discount_offer_made to each new vendor
  try {
    const origin = `https://${req.headers.host}`;
    const invoiceIds = [...new Set(created.map((o) => o.invoice_id))];
    const invNumByIdMap = {};
    if (invoiceIds.length) {
      const { data: invs } = await admin.from("invoices").select("id, invoice_number").in("id", invoiceIds);
      for (const i of invs || []) invNumByIdMap[i.id] = i.invoice_number;
    }
    for (const o of created) {
      const invoiceNumber = invNumByIdMap[o.invoice_id] || o.invoice_id.slice(0, 8);
      const daysEarly = Math.max(0, Math.round((new Date(`${o.original_due_date}T00:00:00Z`).getTime() - new Date(`${o.early_payment_date}T00:00:00Z`).getTime()) / 86400000));
      await fetch(`${origin}/api/send-notification`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "discount_offer_made",
          title: `Early payment offer: get paid ${daysEarly} days early on invoice ${invoiceNumber}`,
          body: `You can be paid on ${o.early_payment_date} instead of ${o.original_due_date} in exchange for a ${Number(o.discount_pct).toFixed(2)}% discount (save $${Number(o.discount_amount).toFixed(2)}).`,
          link: "/vendor/discount-offers",
          metadata: { offer_id: o.id, invoice_id: o.invoice_id, invoice_number: invoiceNumber, days_early: daysEarly },
          recipient: { vendor_id: o.vendor_id },
          dedupe_key: `discount_offer_made_${o.id}`,
          email: true, push: true,
        }),
      }).catch(() => {});
    }
  } catch { /* non-blocking */ }

  return res.status(200).json({ created, skipped });
}
