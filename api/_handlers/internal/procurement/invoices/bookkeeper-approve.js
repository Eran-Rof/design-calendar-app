// api/internal/procurement/invoices/[id]/bookkeeper-approve
//
// Tangerine P13-4 — REAL bookkeeper approval handler for D19 receipt-rollup
// auto-AP invoices. Supersedes the P13-3 stub (h499) that returned 501.
//
// Flow:
//   1. authenticateCaller — Bearer JWT, gets auth_id.
//   2. Resolve actor to employees row + verify role IN ('bookkeeper','admin').
//      Fallback to entity_users.role for operators not yet in employees.
//      403 if neither path yields a bookkeeper/admin.
//   3. Validate body: { action: 'approve' | 'reject', reason: text REQUIRED }.
//      Reason is REQUIRED (T11 D3 + P13 §6.9 — operator typed it in the panel).
//   4. Load invoice + assert status='pending_bookkeeper_approval' AND
//      is_receipt_rollup=true (409 otherwise).
//   5. Wrap the mutating SQL in withAuditContext so the T11 trigger stamps
//      app.actor_auth_id + app.audit_reason + app.audit_source='manual'.
//   6a. action='approve':
//        - Flip invoices.status → 'approved'.
//        - Call postInvoice (the existing P3 AP posting service, exported
//          from api/_handlers/internal/ap-invoices/post.js) with
//          fromApprovalHook=true to bypass the standard P3 approval gate
//          (the bookkeeper IS the gate for receipt-rollup invoices).
//        - The posting service stamps invoices.accrual_je_id +
//          gl_status='posted' on success.
//        - Insert bookkeeper_approval_log row with action='approved', je_id.
//        - If the posting service fails, revert invoices.status to
//          'pending_bookkeeper_approval' so the operator can retry.
//   6b. action='reject':
//        - Flip invoices.status → 'rejected'.
//        - Insert bookkeeper_approval_log row with action='rejected', je_id=NULL.
//   7. Return { invoice_id, action, status, je_id? }.
//
// Body: { action: 'approve' | 'reject', reason: string }

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../_lib/auth.js";
import { withAuditContext, extractActorFromRequest } from "../../../../_lib/audit/context.js";
import { postInvoice } from "../../ap-invoices/post.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(["approve", "reject"]);
const BOOKKEEPER_ROLES = new Set(["bookkeeper", "admin"]);
const REASON_MIN_LEN = 3;
const REASON_MAX_LEN = 2000;

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

/**
 * Pure body validator. Exported for direct testing.
 * Returns { error } or { data: { action, reason } }.
 */
export function validateApproveBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object with action + reason" };
  }
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!action) return { error: "action is required" };
  if (!VALID_ACTIONS.has(action)) {
    return { error: "action must be 'approve' or 'reject'" };
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reasonRaw) {
    return { error: "reason is required (T11 D3 — operator-typed rationale must be captured)" };
  }
  if (reasonRaw.length < REASON_MIN_LEN) {
    return { error: `reason must be at least ${REASON_MIN_LEN} characters` };
  }
  if (reasonRaw.length > REASON_MAX_LEN) {
    return { error: `reason must be ${REASON_MAX_LEN} characters or fewer` };
  }
  return { data: { action, reason: reasonRaw } };
}

/**
 * Resolve the actor to an { employee_id, role, display_name } shape.
 * Tries employees.auth_user_id first, then entity_users.auth_id. Returns
 * null fields when neither lookup hits — caller treats that as 403.
 */
export async function resolveBookkeeperActor(admin, authId) {
  // 1. employees table — preferred path.
  const { data: emp } = await admin
    .from("employees")
    .select("id, role, display_name")
    .eq("auth_user_id", authId)
    .maybeSingle();
  if (emp && BOOKKEEPER_ROLES.has(String(emp.role || "").toLowerCase())) {
    return {
      employee_id: emp.id,
      role: String(emp.role).toLowerCase(),
      display_name: emp.display_name || null,
      source: "employees",
    };
  }

  // 2. entity_users fallback — operators not yet in employees still get to
  //    approve if their entity_users.role grants it.
  const { data: eu } = await admin
    .from("entity_users")
    .select("role")
    .eq("auth_id", authId)
    .maybeSingle();
  if (eu && BOOKKEEPER_ROLES.has(String(eu.role || "").toLowerCase())) {
    return {
      employee_id: emp?.id || null,
      role: String(eu.role).toLowerCase(),
      display_name: emp?.display_name || null,
      source: "entity_users",
    };
  }

  return { employee_id: null, role: null, display_name: null, source: null };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  const v = validateApproveBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const { action, reason } = v.data;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. AuthN — Bearer JWT
  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // 2. AuthZ — bookkeeper role gate
  const actor = await resolveBookkeeperActor(admin, auth.authId);
  if (!actor.role) {
    return res.status(403).json({
      error: "Caller is not a bookkeeper or admin — receipt-rollup AP invoices require bookkeeper approval",
    });
  }

  // 3. Load invoice + assert preconditions.
  const { data: invoice, error: invErr } = await admin
    .from("invoices")
    .select("id, entity_id, vendor_id, invoice_number, status, gl_status, " +
            "is_receipt_rollup, rollup_parent_receipt_id, total_amount_cents, " +
            "expense_account_id, posting_date, accrual_je_id")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (!invoice.is_receipt_rollup) {
    return res.status(409).json({
      error: "Invoice is not a receipt-rollup AP invoice — bookkeeper-approve gate only applies to D19 auto-AP invoices",
    });
  }
  if (invoice.status !== "pending_bookkeeper_approval") {
    return res.status(409).json({
      error: `Invoice status is '${invoice.status}', expected 'pending_bookkeeper_approval'`,
    });
  }

  // 4. Mutate inside withAuditContext so the T11 trigger sees the actor + reason.
  const actorCtx = extractActorFromRequest(req, auth.authId);
  const result = await withAuditContext(admin, {
    userId: actorCtx.authId,
    employeeId: actor.employee_id,
    displayName: actor.display_name,
    source: actorCtx.source,
    reason,
    correlationId: actorCtx.correlationId,
  }, async () => {
    if (action === "approve") {
      return runApprove(admin, invoice, actor, auth.authId, reason);
    }
    return runReject(admin, invoice, actor, auth.authId, reason);
  });

  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(200).json(result.body);
}

/**
 * Approve flow:
 *  - Flip invoices.status → 'approved'.
 *  - Call postInvoice (existing P3 AP service) to post the JE.
 *  - On success: stamp accrual_je_id + log row with je_id.
 *  - On posting failure: revert invoices.status to 'pending_bookkeeper_approval',
 *    log the failure (action='approved', je_id=NULL, reason prefixed
 *    'AUTO-REVERT: ...') and return 500.
 */
export async function runApprove(admin, invoice, actor, authId, reason) {
  // Flip to 'approved' first so any concurrent reader sees the right state.
  const { error: flipErr } = await admin
    .from("invoices")
    .update({ status: "approved" })
    .eq("id", invoice.id);
  if (flipErr) {
    return { error: `Failed to flip invoice status to approved: ${flipErr.message}`, status: 500 };
  }

  // Reload to get the freshest gl_status before posting (defense against
  // an out-of-band reposting). postInvoice expects gl_status != 'posted'.
  const refreshed = { ...invoice, status: "approved" };

  let postResult;
  try {
    postResult = await postInvoice(admin, {
      invoice: refreshed,
      vendor: null,
      vendor_new: false,
      created_by_user_id: authId,
      fromApprovalHook: true,  // bypass P3 approval gate; bookkeeper IS the gate
    });
  } catch (e) {
    postResult = { status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  if (postResult.error || postResult.status >= 400) {
    // Revert + log failure.
    await admin
      .from("invoices")
      .update({ status: "pending_bookkeeper_approval" })
      .eq("id", invoice.id);
    await admin.from("bookkeeper_approval_log").insert({
      entity_id: invoice.entity_id,
      invoice_id: invoice.id,
      action: "approved",
      bookkeeper_employee_id: actor.employee_id,
      bookkeeper_auth_id: authId,
      reason: `AUTO-REVERT: posting failed — ${postResult.error || "unknown error"}. Original reason: ${reason}`,
      je_id: null,
    });
    return {
      error: `Bookkeeper approval recorded but AP posting failed: ${postResult.error || "unknown"}. Invoice reverted to pending_bookkeeper_approval.`,
      status: 500,
    };
  }

  const jeId = postResult.body?.accrual_je_id || null;

  // Log the successful approval.
  const { error: logErr } = await admin
    .from("bookkeeper_approval_log")
    .insert({
      entity_id: invoice.entity_id,
      invoice_id: invoice.id,
      action: "approved",
      bookkeeper_employee_id: actor.employee_id,
      bookkeeper_auth_id: authId,
      reason,
      je_id: jeId,
    });
  if (logErr) {
    // Non-fatal: the JE posted + invoice updated, but the audit log row
    // failed. Surface as a warning in the response but still return 200.
    return {
      status: 200,
      body: {
        invoice_id: invoice.id,
        action: "approve",
        status: "approved",
        gl_status: postResult.body?.gl_status || "posted",
        je_id: jeId,
        warning: `Approval succeeded but audit log insert failed: ${logErr.message}`,
      },
    };
  }

  return {
    status: 200,
    body: {
      invoice_id: invoice.id,
      action: "approve",
      status: "approved",
      gl_status: postResult.body?.gl_status || "posted",
      je_id: jeId,
    },
  };
}

/**
 * Reject flow:
 *  - Flip invoices.status → 'rejected'.
 *  - Insert bookkeeper_approval_log row with action='rejected', je_id=NULL.
 *  - No JE is posted.
 */
export async function runReject(admin, invoice, actor, authId, reason) {
  const { error: flipErr } = await admin
    .from("invoices")
    .update({ status: "rejected" })
    .eq("id", invoice.id);
  if (flipErr) {
    return { error: `Failed to flip invoice status to rejected: ${flipErr.message}`, status: 500 };
  }

  const { error: logErr } = await admin
    .from("bookkeeper_approval_log")
    .insert({
      entity_id: invoice.entity_id,
      invoice_id: invoice.id,
      action: "rejected",
      bookkeeper_employee_id: actor.employee_id,
      bookkeeper_auth_id: authId,
      reason,
      je_id: null,
    });
  if (logErr) {
    return {
      status: 200,
      body: {
        invoice_id: invoice.id,
        action: "reject",
        status: "rejected",
        warning: `Rejection succeeded but audit log insert failed: ${logErr.message}`,
      },
    };
  }

  return {
    status: 200,
    body: {
      invoice_id: invoice.id,
      action: "reject",
      status: "rejected",
    },
  };
}
