// api/internal/scf/requests
//
// GET — list finance requests across vendors.
//   ?status=&program_id=&vendor_id=

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
  const status    = url.searchParams.get("status");
  const programId = url.searchParams.get("program_id");
  const vendorId  = url.searchParams.get("vendor_id");

  let q = admin.from("finance_requests")
    .select("*, program:supply_chain_finance_programs(id, name, max_facility_amount, current_utilization, base_rate_pct, status), vendor:vendors(id, name), invoice:invoices(id, invoice_number, total, due_date)")
    .order("requested_at", { ascending: false });
  if (status)    q = q.eq("status", status);
  if (programId) q = q.eq("program_id", programId);
  if (vendorId)  q = q.eq("vendor_id", vendorId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
