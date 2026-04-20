// api/vendor/payments
//
// GET — vendor's payments history with FX detail rows joined.
//       Virtual cards are included in the same payload for the
//       combined /vendor/payments page.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";
import { maskCard } from "../../../_lib/virtual-card.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  const [{ data: payments }, { data: cards }] = await Promise.all([
    admin.from("payments")
      .select("*, invoice:invoices(id, invoice_number, total)")
      .eq("vendor_id", vendorId)
      .order("initiated_at", { ascending: false })
      .limit(100),
    admin.from("virtual_cards")
      .select("id, entity_id, invoice_id, vendor_id, card_number_last4, expiry_month, expiry_year, credit_limit, amount_spent, status, provider, issued_at, expires_at, spent_at, invoice:invoices(id, invoice_number, total)")
      .eq("vendor_id", vendorId)
      .order("issued_at", { ascending: false }),
  ]);

  // Attach FX detail in one batch
  const paymentIds = (payments || []).map((p) => p.id);
  const fxByPaymentId = {};
  if (paymentIds.length) {
    const { data: ips } = await admin.from("international_payments").select("*").in("payment_id", paymentIds);
    for (const ip of ips || []) fxByPaymentId[ip.payment_id] = ip;
  }

  return res.status(200).json({
    payments: (payments || []).map((p) => ({ ...p, fx: fxByPaymentId[p.id] || null })),
    virtual_cards: (cards || []).map((c) => ({ ...maskCard(c), invoice: c.invoice })),
  });
}
