// api/internal/scf/requests/:id/approve
//
// PUT — approve a requested finance request.
//   body: { approved_amount?, fee_pct?, rejection_reason? (if rejecting) }

import { createClient } from "@supabase/supabase-js";
import { nextStatus, planApproval, hasCapacity } from "../../../../../_lib/scf.js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("approve");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing request id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const { data: request } = await admin.from("finance_requests")
    .select("*, program:supply_chain_finance_programs(*), invoice:invoices(id, due_date)")
    .eq("id", id).maybeSingle();
  if (!request) return res.status(404).json({ error: "Finance request not found" });

  try { nextStatus(request.status, "approved"); }
  catch (err) { return res.status(409).json({ error: err?.message || String(err) }); }

  const approved_amount = Number(body?.approved_amount ?? request.requested_amount);
  if (!Number.isFinite(approved_amount) || approved_amount <= 0) return res.status(400).json({ error: "approved_amount must be > 0" });
  if (!hasCapacity(request.program, approved_amount)) return res.status(409).json({ error: "Program does not have capacity for this approval" });

  const { patch } = planApproval({
    program: request.program, request, invoice: request.invoice,
    approved_amount, fee_pct_override: body?.fee_pct ?? null,
  });

  // Idempotent flip — same pattern as fund.js. The WHERE includes
  // status='pending' so two concurrent approves both pass the
  // nextStatus check above but only one actually flips the row, the
  // other returns 0 rows updated and we 409 it. Without this guard
  // both would succeed, double-fire the approval notification, and
  // depending on the program cap eat capacity twice.
  const expectedStatus = String(request.status || "pending");
  const { data: flipped, error } = await admin.from("finance_requests")
    .update(patch)
    .eq("id", id)
    .eq("status", expectedStatus)
    .select("id");
  if (error) return res.status(500).json({ error: error.message });
  if (!flipped || flipped.length === 0) {
    return res.status(409).json({ error: "Finance request status changed since fetch — already approved?" });
  }

  // Notify vendor
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "scf_request_approved",
        title: `Financing approved: $${Number(patch.approved_amount).toLocaleString()}`,
        body: `Your finance request was approved. Net disbursement: $${Number(patch.net_disbursement).toLocaleString()} after a ${Number(patch.fee_pct).toFixed(3)}% fee.`,
        link: "/vendor/scf",
        metadata: { finance_request_id: id, approved_amount: patch.approved_amount, net_disbursement: patch.net_disbursement },
        recipient: { vendor_id: request.vendor_id },
        dedupe_key: `scf_request_approved_${id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, ...patch });
}
