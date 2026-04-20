// api/internal/discount-offers
//
// GET — all offers for an entity, with computed annualized return.
//   ?entity_id=<uuid>  required (or X-Entity-ID header)
//   ?status=offered|accepted|rejected|expired|paid
//   ?vendor_id=<uuid>
//   ?from=<ISO>&to=<ISO>  — offered_at range

import { createClient } from "@supabase/supabase-js";
import { computeAnnualizedReturn } from "../../../_lib/discount-offers.js";

export const config = { maxDuration: 15 };

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
  if (!entityId) return res.status(400).json({ error: "entity_id query or X-Entity-ID header required" });
  const status = url.searchParams.get("status");
  const vendorId = url.searchParams.get("vendor_id");
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  let q = admin.from("dynamic_discount_offers")
    .select("*, vendor:vendors(id, name), invoice:invoices(id, invoice_number, total)")
    .eq("entity_id", entityId)
    .order("offered_at", { ascending: false });
  if (status)   q = q.eq("status", status);
  if (vendorId) q = q.eq("vendor_id", vendorId);
  if (from)     q = q.gte("offered_at", from);
  if (to)       q = q.lte("offered_at", to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || []).map((o) => {
    const days = daysBetween(o.early_payment_date, o.original_due_date);
    return { ...o, days_early: days, annualized_return_pct: round2(computeAnnualizedReturn(Number(o.discount_pct || 0), days)) };
  });

  return res.status(200).json({ rows });
}

function daysBetween(a, b) {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86400000);
}
function round2(n) { return Math.round(n * 100) / 100; }
