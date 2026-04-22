// api/vendor/scf/requests
//
// GET — the authenticated vendor's finance requests.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

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

  const { data, error } = await admin.from("finance_requests")
    .select("*, program:supply_chain_finance_programs(id, name, funder_name), invoice:invoices(id, invoice_number, total, due_date)")
    .eq("vendor_id", authRes.auth.vendor_id)
    .order("requested_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
