// api/internal/tax/calculations
//
// GET — tax_calculations filtered by jurisdiction / tax_type / period.
// Also supports invoice_id for per-invoice lookup.
//
//   ?jurisdiction=&tax_type=&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>&invoice_id=

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const jurisdiction = url.searchParams.get("jurisdiction");
  const taxType = url.searchParams.get("tax_type");
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  const invoiceId = url.searchParams.get("invoice_id");

  let q = admin.from("tax_calculations")
    .select("*, invoice:invoices(id, invoice_number, vendor_id, total, invoice_date)")
    .order("calculated_at", { ascending: false });
  if (jurisdiction) q = q.eq("jurisdiction", jurisdiction);
  if (taxType) q = q.eq("tax_type", taxType);
  if (invoiceId) q = q.eq("invoice_id", invoiceId);
  if (from) q = q.gte("calculated_at", `${from}T00:00:00Z`);
  if (to)   q = q.lte("calculated_at", `${to}T23:59:59Z`);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
