// api/vendor/scf/request
//
// POST — submit a finance request against one of the vendor's approved invoices.
//   body: { invoice_id, program_id }

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";
import { isInvoiceEligible, hasCapacity, calculateFee, daysToDueDate } from "../../../_lib/scf.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { invoice_id, program_id } = body || {};
  if (!invoice_id || !program_id) return res.status(400).json({ error: "invoice_id and program_id required" });

  const [{ data: invoice }, { data: program }, { data: existing }] = await Promise.all([
    admin.from("invoices").select("id, vendor_id, entity_id, total, due_date, status").eq("id", invoice_id).maybeSingle(),
    admin.from("supply_chain_finance_programs").select("*").eq("id", program_id).maybeSingle(),
    admin.from("finance_requests").select("invoice_id, status").eq("vendor_id", vendorId),
  ]);

  if (!invoice || invoice.vendor_id !== vendorId) return res.status(404).json({ error: "Invoice not found" });
  if (!program) return res.status(404).json({ error: "Program not found" });

  const eligible = isInvoiceEligible(invoice, existing || []);
  if (!eligible.ok) return res.status(409).json({ error: `Not eligible: ${eligible.reason}` });

  if (!hasCapacity(program, Number(invoice.total))) return res.status(409).json({ error: "Program does not have capacity" });

  const days = daysToDueDate(invoice.due_date);
  const fee = calculateFee({ amount: invoice.total, baseRatePct: program.base_rate_pct, daysToDue: days });

  const { data: created, error } = await admin.from("finance_requests").insert({
    program_id,
    invoice_id,
    vendor_id: vendorId,
    requested_amount: invoice.total,
    fee_pct: fee.fee_pct,
    fee_amount: fee.fee_amount,
    net_disbursement: fee.net_disbursement,
    status: "requested",
    repayment_due_date: invoice.due_date,
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify internal team
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "scf_request_received",
        title: `Finance request: $${Number(invoice.total).toLocaleString()} against invoice`,
        body: `A vendor submitted a finance request for $${Number(invoice.total).toLocaleString()} on program '${program.name}'.`,
        link: "/",
        metadata: { finance_request_id: created.id, program_id, invoice_id },
        recipient: { internal_id: "scf-team", email: process.env.INTERNAL_FINANCE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "" },
        dedupe_key: `scf_request_received_${created.id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json(created);
}
