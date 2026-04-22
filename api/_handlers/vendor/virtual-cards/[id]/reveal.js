// api/vendor/virtual-cards/:id/reveal
//
// GET — one-time-ish reveal of the full card details within 24h of issuance.
// After the window closes, returns 410 Gone.
//
// Auth: authenticated vendor user whose vendor_id matches the card.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";
import { decryptBytes, revealStillValid } from "../../../../_lib/virtual-card.js";

export const config = { maxDuration: 10 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("reveal");
  return idx > 0 ? parts[idx - 1] : null;
}

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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing card id" });

  const { data: card } = await admin.from("virtual_cards")
    .select("id, vendor_id, card_number_encrypted, cvv_encrypted, card_number_last4, expiry_month, expiry_year, credit_limit, issued_at, status")
    .eq("id", id).maybeSingle();
  if (!card || card.vendor_id !== authRes.auth.vendor_id) return res.status(404).json({ error: "Card not found" });
  if (!revealStillValid(card.issued_at)) return res.status(410).json({ error: "Reveal window has closed (24h after issuance)" });
  if (card.status !== "active") return res.status(409).json({ error: `Card is ${card.status}` });

  let card_number, cvv;
  try {
    card_number = decryptBytes(card.card_number_encrypted);
    cvv = decryptBytes(card.cvv_encrypted);
  } catch {
    return res.status(500).json({ error: "Failed to decrypt card details" });
  }

  return res.status(200).json({
    card_number, cvv,
    card_number_last4: card.card_number_last4,
    expiry_month: card.expiry_month, expiry_year: card.expiry_year,
    credit_limit: card.credit_limit,
    warning: "Record these details now — this link expires 24 hours after the card was issued.",
  });
}
