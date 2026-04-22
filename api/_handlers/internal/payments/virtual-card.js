// api/internal/payments/virtual-card
//
// POST — issue a virtual card against an approved invoice.
//   body: { invoice_id, provider?: "stripe" | "marqeta" | "railsbank" }
//
// Flow:
//   1. Validates invoice is approved.
//   2. Calls the card-provider stub (replace with real Stripe/Marqeta client).
//   3. Encrypts PAN + CVV with AES-256-GCM (via virtual-card lib).
//   4. Inserts the virtual_cards row with expires_at = 2 years from now.
//   5. Fires virtual_card_issued notification with a 24h reveal URL.
//
// Response returns the MASKED card (last4 only) + the reveal URL to hand
// to the vendor out-of-band.

import { createClient } from "@supabase/supabase-js";
import { issueCardWithProvider, encryptBytes, maskCard } from "../../../_lib/virtual-card.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { invoice_id, provider } = body || {};
  if (!invoice_id) return res.status(400).json({ error: "invoice_id required" });
  const chosenProvider = provider || "stripe";
  if (!["stripe", "marqeta", "railsbank"].includes(chosenProvider)) {
    return res.status(400).json({ error: "provider must be stripe | marqeta | railsbank" });
  }

  const { data: invoice } = await admin.from("invoices")
    .select("id, entity_id, vendor_id, total, status").eq("id", invoice_id).maybeSingle();
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  if (invoice.status !== "approved") return res.status(409).json({ error: "Invoice must be approved to issue a card" });

  // Call provider (stub)
  let card;
  try {
    card = await issueCardWithProvider({ provider: chosenProvider, credit_limit: Number(invoice.total) });
  } catch (err) {
    return res.status(502).json({ error: `Provider error: ${err?.message || err}` });
  }

  // Encrypt sensitive fields
  const card_number_encrypted = encryptBytes(card.card_number);
  const cvv_encrypted = encryptBytes(card.cvv);

  // 2-year expiry (matches provider card life; can be tightened via env later)
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(); expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 2);

  const { data: inserted, error } = await admin.from("virtual_cards").insert({
    entity_id: invoice.entity_id,
    invoice_id: invoice.id,
    vendor_id: invoice.vendor_id,
    card_number_last4: card.card_number_last4,
    card_number_encrypted,
    cvv_encrypted,
    expiry_month: card.expiry_month,
    expiry_year: card.expiry_year,
    credit_limit: card.credit_limit,
    status: "active",
    provider: chosenProvider,
    provider_card_id: card.provider_card_id,
    issued_at: nowIso,
    expires_at: expiresAt.toISOString(),
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  // 24h reveal URL — relies on caller being an authenticated vendor user who
  // owns the card; the window is enforced server-side via issued_at.
  const origin = `https://${req.headers.host}`;
  const revealUrl = `${origin}/vendor/virtual-cards/${inserted.id}/reveal`;

  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "virtual_card_issued",
        title: `Virtual card issued: $${Number(inserted.credit_limit).toLocaleString()} limit`,
        body: `A virtual card has been issued against an approved invoice. Card details are available for 24 hours via this link:\n\n${revealUrl}\n\nAfter that, only the last 4 digits (${inserted.card_number_last4}) will be shown.`,
        link: revealUrl,
        metadata: { card_id: inserted.id, invoice_id, last4: inserted.card_number_last4 },
        recipient: { vendor_id: invoice.vendor_id },
        dedupe_key: `virtual_card_issued_${inserted.id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json({ card: maskCard(inserted), reveal_url: revealUrl });
}
