// api/internal/scf/requests/:id/fund
//
// PUT — mark a finance request as funded (disbursement confirmed).
// Bumps `supply_chain_finance_programs.current_utilization` by approved_amount.
// Optionally inserts a `payments` row for the net_disbursement to the vendor.

import { createClient } from "@supabase/supabase-js";
import { nextStatus } from "../../../../../_lib/scf.js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("fund");
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

  const { data: request } = await admin.from("finance_requests")
    .select("*, program:supply_chain_finance_programs(*), invoice:invoices(id, currency)")
    .eq("id", id).maybeSingle();
  if (!request) return res.status(404).json({ error: "Finance request not found" });

  try { nextStatus(request.status, "funded"); }
  catch (err) { return res.status(409).json({ error: err?.message || String(err) }); }

  const nowIso = new Date().toISOString();

  // Idempotent flip to funded: the WHERE includes status='approved' so
  // a duplicate fund request returns zero rows updated and we exit
  // with a 409. Without this guard, two concurrent fund() calls on
  // the same finance_request both pass the nextStatus check above and
  // both bump utilization + insert a payments row.
  const { data: flipped, error: updErr } = await admin.from("finance_requests")
    .update({ status: "funded", funded_at: nowIso, updated_at: nowIso })
    .eq("id", id)
    .eq("status", "approved")
    .select("id");
  if (updErr) return res.status(500).json({ error: updErr.message });
  if (!flipped || flipped.length === 0) {
    return res.status(409).json({ error: "Finance request status changed since fetch — already funded?" });
  }

  // Bump program utilization. Read-modify-write still has a residual
  // race when TWO different finance_requests under the same program
  // are funded concurrently — both reads observe the same starting
  // value and the second write wins, losing the first's increment.
  // Without a Postgres function for atomic increment, the next-best
  // mitigation is a retry loop on PATCH-WHERE-old-value.
  const approved = Number(request.approved_amount || 0);
  let newUtil = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: prog } = await admin.from("supply_chain_finance_programs")
      .select("current_utilization, updated_at")
      .eq("id", request.program_id)
      .maybeSingle();
    if (!prog) break;
    const observed = Number(prog.current_utilization || 0);
    const candidate = Math.round((observed + approved) * 10000) / 10000;
    const { data: ok } = await admin.from("supply_chain_finance_programs")
      .update({ current_utilization: candidate, updated_at: nowIso })
      .eq("id", request.program_id)
      .eq("updated_at", prog.updated_at)
      .select("id");
    if (ok && ok.length > 0) { newUtil = candidate; break; }
    // Lost the race — re-read and retry. Exponential backoff capped at 200ms.
    await new Promise((r) => setTimeout(r, Math.min(200, 25 * (attempt + 1))));
  }
  if (newUtil == null) {
    console.warn("[scf-fund] could not atomically bump utilization", { request_id: id, program_id: request.program_id });
  }

  // Create a payments row for the net disbursement (best-effort)
  let payment_id = null;
  try {
    const { data: payment } = await admin.from("payments").insert({
      entity_id: request.program.entity_id,
      invoice_id: request.invoice_id,
      vendor_id: request.vendor_id,
      amount: request.net_disbursement,
      currency: request.invoice?.currency || "USD",
      method: "wire",
      status: "initiated",
      reference: `SCF ${id.slice(0, 8)}`,
      metadata: { finance_request_id: id, program_id: request.program_id, fee_amount: request.fee_amount },
    }).select("id").single();
    payment_id = payment?.id || null;
  } catch { /* non-blocking */ }

  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "scf_funded",
        title: `Disbursement sent: $${Number(request.net_disbursement).toLocaleString()}`,
        body: `Your finance request has been funded. Net disbursement: $${Number(request.net_disbursement).toLocaleString()}. Repayment due ${request.repayment_due_date}.`,
        link: "/vendor/scf",
        metadata: { finance_request_id: id, payment_id },
        recipient: { vendor_id: request.vendor_id },
        dedupe_key: `scf_funded_${id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, status: "funded", payment_id, program_utilization: newUtil });
}
