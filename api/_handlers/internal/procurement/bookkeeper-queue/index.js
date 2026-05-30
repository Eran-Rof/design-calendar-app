// api/internal/procurement/bookkeeper-queue
//
// Tangerine P13-3 — GET pending bookkeeper-approval AP invoices spawned by
// the D19 receipt-rollup workflow. The bookkeeper approval queue panel
// surfaces these for approve/reject.
//
// Filter: invoices WHERE is_receipt_rollup=true AND
// status='pending_bookkeeper_approval' by default. Optional:
//   ?include_history=true → also include approved + rejected rollup invoices

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const includeHistory = url.searchParams.get("include_history") === "true";
  let limit = parseInt(url.searchParams.get("limit") || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  let q = admin
    .from("invoices")
    .select(
      "id, entity_id, vendor_id, invoice_number, invoice_kind, status, gl_status, " +
      "posting_date, total_amount_cents, expense_account_id, description, " +
      "is_receipt_rollup, rollup_parent_receipt_id, source, created_at, updated_at"
    )
    .eq("is_receipt_rollup", true)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!includeHistory) {
    q = q.eq("status", "pending_bookkeeper_approval");
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
