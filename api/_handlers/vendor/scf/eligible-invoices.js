// api/vendor/scf/eligible-invoices
//
// GET — invoices this vendor can finance right now.
//   ?program_id=<uuid>  required to preview fees; otherwise uses first active program for the invoice's entity
// Returns: [{ invoice, est_fee_pct, est_fee_amount, est_net_disbursement, days_to_due }]

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";
import { calculateFee, daysToDueDate, isInvoiceEligible } from "../../../_lib/scf.js";

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

  const url = new URL(req.url, `https://${req.headers.host}`);
  const programIdParam = url.searchParams.get("program_id");

  const [{ data: invoices }, { data: existing }] = await Promise.all([
    admin.from("invoices")
      .select("id, entity_id, invoice_number, total, currency, due_date, status")
      .eq("vendor_id", vendorId).eq("status", "approved"),
    admin.from("finance_requests").select("invoice_id, status").eq("vendor_id", vendorId),
  ]);

  // Resolve program(s): either the caller-specified one or the first active per entity
  let programsByEntity = {};
  if (programIdParam) {
    const { data: p } = await admin.from("supply_chain_finance_programs").select("*").eq("id", programIdParam).maybeSingle();
    if (p) programsByEntity[p.entity_id] = p;
  } else {
    const entityIds = [...new Set((invoices || []).map((i) => i.entity_id))];
    if (entityIds.length) {
      const { data: programs } = await admin.from("supply_chain_finance_programs")
        .select("*").in("entity_id", entityIds).eq("status", "active");
      for (const p of programs || []) if (!programsByEntity[p.entity_id]) programsByEntity[p.entity_id] = p;
    }
  }

  const out = [];
  for (const inv of invoices || []) {
    const eligible = isInvoiceEligible(inv, existing || []);
    if (!eligible.ok) continue;
    const program = programsByEntity[inv.entity_id];
    if (!program) continue;
    const days = daysToDueDate(inv.due_date);
    const fee = calculateFee({ amount: inv.total, baseRatePct: program.base_rate_pct, daysToDue: days });
    out.push({
      invoice: inv,
      program_id: program.id,
      program_name: program.name,
      days_to_due: days,
      est_fee_pct: fee.fee_pct,
      est_fee_amount: fee.fee_amount,
      est_net_disbursement: fee.net_disbursement,
    });
  }
  return res.status(200).json({ rows: out });
}
