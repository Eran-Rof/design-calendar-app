// api/internal/virtual-cards
//
// GET — all cards (masked). Filters: ?status=&vendor_id=&entity_id=

import { createClient } from "@supabase/supabase-js";
import { maskCard } from "../../../_lib/virtual-card.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  const status = url.searchParams.get("status");
  const vendorId = url.searchParams.get("vendor_id");

  let q = admin.from("virtual_cards")
    .select("id, entity_id, invoice_id, vendor_id, card_number_last4, expiry_month, expiry_year, credit_limit, amount_authorized, amount_spent, status, provider, issued_at, expires_at, spent_at, vendor:vendors(id, name), invoice:invoices(id, invoice_number, total)")
    .order("issued_at", { ascending: false });
  if (entityId) q = q.eq("entity_id", entityId);
  if (status)   q = q.eq("status", status);
  if (vendorId) q = q.eq("vendor_id", vendorId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: (data || []).map((row) => ({ ...maskCard(row), vendor: row.vendor, invoice: row.invoice })) });
}
