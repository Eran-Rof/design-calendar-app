// api/vendor/virtual-cards
//
// GET — masked cards issued to the authenticated vendor. Never returns PAN/CVV.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";
import { maskCard } from "../../../_lib/virtual-card.js";

export const config = { maxDuration: 10 };

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

  const { data, error } = await admin.from("virtual_cards")
    .select("id, entity_id, invoice_id, vendor_id, card_number_last4, expiry_month, expiry_year, credit_limit, amount_authorized, amount_spent, status, provider, issued_at, expires_at, spent_at, invoice:invoices(id, invoice_number, total)")
    .eq("vendor_id", authRes.auth.vendor_id)
    .order("issued_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: (data || []).map((row) => ({ ...maskCard(row), invoice: row.invoice })) });
}
