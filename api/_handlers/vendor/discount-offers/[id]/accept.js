// api/vendor/discount-offers/:id/accept
//
// POST — vendor accepts the offer. Creates a payment row targeted at
// early_payment_date and notifies the internal AP team.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("accept");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing offer id" });

  const { data: offer } = await admin.from("dynamic_discount_offers")
    .select("*, invoice:invoices(id, invoice_number, total, currency)")
    .eq("id", id).eq("vendor_id", authRes.auth.vendor_id).maybeSingle();
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (offer.status !== "offered") return res.status(409).json({ error: `Offer is already ${offer.status}` });
  if (new Date(offer.expires_at) < new Date()) return res.status(409).json({ error: "Offer has expired" });

  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin.from("dynamic_discount_offers")
    .update({ status: "accepted", accepted_at: nowIso, updated_at: nowIso })
    .eq("id", id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Create a payments row targeted at early_payment_date
  let payment_id = null;
  try {
    const { data: payment } = await admin.from("payments").insert({
      entity_id: offer.entity_id,
      invoice_id: offer.invoice_id,
      vendor_id: offer.vendor_id,
      amount: offer.net_payment_amount,
      currency: offer.invoice?.currency || "USD",
      method: "ach",
      status: "initiated",
      reference: `DDO ${id.slice(0, 8)}`,
      metadata: { discount_offer_id: id, discount_amount: offer.discount_amount, target_pay_date: offer.early_payment_date },
    }).select("id").single();
    payment_id = payment?.id || null;
  } catch (err) {
    // Non-fatal: offer is accepted; payment creation can be retried manually
  }

  // Notify internal AP team — env vars are comma-separated, fan out per email.
  try {
    const emails = (process.env.INTERNAL_FINANCE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    const origin = `https://${req.headers.host}`;
    for (const email of emails) {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "discount_offer_accepted",
          title: `Discount offer accepted — early pay ${offer.invoice?.invoice_number || offer.invoice_id}`,
          body: `Vendor accepted the offer. Pay $${Number(offer.net_payment_amount).toFixed(2)} on ${offer.early_payment_date} (saves $${Number(offer.discount_amount).toFixed(2)}).`,
          link: "/",
          metadata: { offer_id: id, invoice_id: offer.invoice_id, payment_id },
          recipient: { internal_id: "ap-team", email },
          dedupe_key: `discount_offer_accepted_${id}_${email}`,
          email: true,
        }),
      }).catch(() => {});
    }
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, status: "accepted", payment_id });
}
