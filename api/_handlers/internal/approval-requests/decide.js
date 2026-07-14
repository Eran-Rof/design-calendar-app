// api/internal/approval-requests/:id/decide
//
// POST — record approve / reject / request_changes on a step. Body:
//        { step_id, decision: 'approve'|'reject'|'request_changes', notes?, actor_user_id }
//
// Auto-finalizes the request when the last open step closes (approved) or
// the first reject lands (rejected).
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { decide as decideLib, ApprovalsError } from "../../../_lib/approvals/index.js";
import { postInvoice as postApInvoice } from "../ap-invoices/post.js";
import { postInvoice as postArInvoice } from "../ar-invoices/post.js";
import { postManualJournalEntry } from "../journal-entries/index.js";
import { executeApPayment } from "../ap-invoices/pay.js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await decideLib(admin,
      { request_id: id, step_id: v.data.step_id, decision: v.data.decision, notes: v.data.notes },
      { actor_user_id: v.data.actor_user_id });

    // Post-decision side-effect: when an ap_invoice approval finalizes as
    // approved, re-run the post path against the still-pending invoice.
    // Per P3 arch §3.6 ("when the approval flips to approved, a small webhook
    // handler re-runs the post path"). Option (a) in P3-2: wire it here as a
    // best-effort side-effect — failures don't block the decide response.
    let postedHook = null;
    if (out?.finalized && out?.request?.status === "approved") {
      try {
        const { data: reqRow } = await admin
          .from("approval_requests")
          .select("id, kind, context_table, context_id, entity_id, payload")
          .eq("id", id)
          .maybeSingle();

        // Maker/checker: manual JE. The JE was NOT written when the request was
        // opened — the full post payload is snapshotted in payload. Post it now
        // (attributed to the maker, not the approver), then rewrite context_id
        // to the real posted JE so JEDetailModal links the approval history.
        if (reqRow && reqRow.kind === "je_manual_post" && reqRow.context_table === "journal_entries") {
          const p = reqRow.payload || {};
          const result = await postManualJournalEntry(admin, {
            entityId: p.entity_id,
            data: {
              basis: p.basis,
              posting_date: p.posting_date,
              description: p.description,
              journal_type: p.journal_type,
              lines: p.lines,
            },
            reason: p.reason || `Approved manual journal entry (approval ${id})`,
            actor: { auth_id: p.created_by_user_id || null, employee_id: null, display_name: null },
            correlation_id: id,
          });
          postedHook = result.body || { status: result.status };
          const posted = result?.body?.posted;
          if (Array.isArray(posted) && posted.length) {
            const primary = posted.find((x) => x.basis === "ACCRUAL") || posted[0];
            if (primary?.je_id) {
              await admin.from("approval_requests").update({ context_id: primary.je_id }).eq("id", id);
            }
          }
        }
        // Maker/checker: AP payment. No invoice_payments row was written when
        // the request opened — the pay params are snapshotted in payload.
        // Execute the payment now (posts cash + sibling JEs).
        else if (reqRow && reqRow.kind === "ap_payment" && reqRow.context_table === "invoices") {
          const p = reqRow.payload || {};
          const { data: invoice } = await admin
            .from("invoices")
            .select("*")
            .eq("id", reqRow.context_id)
            .maybeSingle();
          if (invoice && invoice.gl_status === "posted") {
            const result = await executeApPayment(admin, {
              invoice,
              params: {
                payment_date: p.payment_date,
                amount_cents: p.amount_cents,
                bank_account_id: p.bank_account_id || null,
                method: p.method,
                reference: p.reference || null,
                notes: p.notes || null,
                created_by_user_id: p.created_by_user_id || null,
              },
            });
            postedHook = result.body || { status: result.status };
          } else {
            postedHook = { skipped: `invoice not payable (gl_status=${invoice?.gl_status ?? "missing"})` };
          }
        }
        else if (reqRow && reqRow.kind === "ap_invoice" && reqRow.context_table === "invoices") {
          const { data: invoice } = await admin
            .from("invoices")
            .select("*")
            .eq("id", reqRow.context_id)
            .maybeSingle();
          if (invoice && invoice.gl_status === "pending_approval") {
            const { data: vendor } = await admin
              .from("vendors")
              .select("id, vendor_code, name, created_at")
              .eq("id", invoice.vendor_id)
              .maybeSingle();
            const result = await postApInvoice(admin, {
              invoice,
              vendor,
              vendor_new: false,
              created_by_user_id: v.data.actor_user_id,
              fromApprovalHook: true,
            });
            postedHook = result.body || { status: result.status, error: result.error };
          }
        }
        // P4-7: AR-side hook mirrors the AP pattern. Recognized request kinds
        // for ar_invoices: 'ar_invoice' (threshold gate, P4-4) and
        // 'customer_credit_extension' (credit-limit breach gate, P4-7). Both
        // re-enter postArInvoice with fromApprovalHook=true (which skips ALL
        // approval gates) so the post proceeds atomically.
        else if (
          reqRow &&
          (reqRow.kind === "ar_invoice" || reqRow.kind === "customer_credit_extension") &&
          reqRow.context_table === "ar_invoices"
        ) {
          // Only re-run if there isn't ANOTHER pending request still open for
          // this invoice (covers the case where both ar_invoice AND credit
          // gates were tripped — the second one is created only after the first
          // clears in the current code path, but defend against the future case).
          const { data: stillPending } = await admin
            .from("approval_requests")
            .select("id")
            .eq("context_table", "ar_invoices")
            .eq("context_id", reqRow.context_id)
            .eq("status", "pending")
            .neq("id", id)
            .limit(1);
          if (stillPending && stillPending.length > 0) {
            postedHook = { skipped: "another approval still pending" };
          } else {
            const { data: invoice } = await admin
              .from("ar_invoices")
              .select("*")
              .eq("id", reqRow.context_id)
              .maybeSingle();
            if (invoice && invoice.gl_status === "pending_approval") {
              const { data: customer } = await admin
                .from("customers")
                .select("id, customer_code, name, created_at")
                .eq("id", invoice.customer_id)
                .maybeSingle();
              const result = await postArInvoice(admin, {
                invoice,
                customer,
                customer_new: false,
                created_by_user_id: v.data.actor_user_id,
                fromApprovalHook: true,
              });
              postedHook = result.body || { status: result.status, error: result.error };
            }
          }
        }
      } catch (hookErr) {
        // Hook failures don't fail the decide call. Surface in the response
        // so the UI can show a warning if needed.
        postedHook = { error: hookErr instanceof Error ? hookErr.message : String(hookErr) };
      }
    }

    return res.status(200).json({ ...out, post_hook: postedHook });
  } catch (err) {
    if (err instanceof ApprovalsError) {
      const status = mapApprovalsErrorStatus(err.code);
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}

export function validateBody(body) {
  if (!body.step_id || !/^[0-9a-f-]{36}$/i.test(String(body.step_id))) {
    return { error: "step_id (uuid) is required" };
  }
  if (!["approve", "reject", "request_changes"].includes(body.decision)) {
    return { error: "decision must be approve|reject|request_changes" };
  }
  if (!body.actor_user_id || !/^[0-9a-f-]{36}$/i.test(String(body.actor_user_id))) {
    return { error: "actor_user_id (uuid) is required" };
  }
  return {
    data: {
      step_id: body.step_id,
      decision: body.decision,
      notes: body.notes ? String(body.notes).trim() : null,
      actor_user_id: body.actor_user_id,
    },
  };
}

function mapApprovalsErrorStatus(code) {
  switch (code) {
    case "request_not_found":
    case "step_not_found":
      return 404;
    case "request_not_pending":
    case "step_already_fulfilled":
    case "prior_steps_open":
    case "actor_role_mismatch":
      return 409;
    case "self_approval_forbidden":
      return 403;
    case "invalid_decision":
    case "missing_request_id":
    case "missing_step_id":
    case "missing_actor":
      return 400;
    default:
      return 500;
  }
}
