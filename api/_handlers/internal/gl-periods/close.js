// api/internal/gl-periods/:id/close
//
// POST. Body: {
//   target_status: 'soft_close' | 'closed',
//   actor_user_id?: <uuid>,
//   reason?: <text>,                        // optional for soft_close, recommended for closed
//   ignore_warnings?: boolean               // P5-1: no-op until P5-7 wires preflight
// }
//
// 1. Resolves the period.
// 2. Validates state-machine transition (open→soft_close, soft_close→closed).
//    Same-status is accepted as idempotent no-op (returns 200).
// 3. Runs M27 approvalsAPI.requestIfRequired with kind='gl_period_close'.
//    Operator opts in via the M27 admin UI — without a rule, no gate fires.
// 4. Sets PG session vars (tangerine.period_close_actor, .period_close_reason)
//    so the AFTER UPDATE trigger captures the actor + reason in the audit log.
// 5. UPDATE gl_periods status — fires the audit trigger.
// 6. Enqueues M28 notification (kind='gl_period_soft_closed' or '_closed').
//
// Pre-flight checks (trial-balance balanced, no draft JEs, etc) are added in
// P5-7. For P5-1 the close is permitted as long as the state-machine allows
// it.
//
// Tangerine P5-1.

import { createClient } from "@supabase/supabase-js";
import { requestIfRequired, ApprovalsError } from "../../../_lib/approvals/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_STATUSES = new Set(["soft_close", "closed"]);

// Allowed transitions for the close handler. (reopen.js handles the reverse.)
// closed_with_closing_jes is one-way terminal — set only by the P5-6 year-end
// RPC, never via this handler.
const ALLOWED_FROM = {
  soft_close: new Set(["open", "soft_close"]),                 // open→soft, idempotent same
  closed:     new Set(["soft_close", "closed"]),               // soft→closed, idempotent same
};

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.target_status || !TARGET_STATUSES.has(body.target_status)) {
    return { error: "target_status must be 'soft_close' or 'closed'" };
  }
  const out = {
    target_status: body.target_status,
    actor_user_id: null,
    reason: null,
    ignore_warnings: body.ignore_warnings === true,
  };
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) {
      return { error: "actor_user_id must be a UUID" };
    }
    out.actor_user_id = String(body.actor_user_id);
  }
  if (body.reason != null) {
    const r = String(body.reason).trim();
    if (r.length > 500) return { error: "reason must be <= 500 chars" };
    if (r.length > 0) out.reason = r;
  }
  return { data: out };
}

export function transitionAllowed(fromStatus, targetStatus) {
  const allowed = ALLOWED_FROM[targetStatus];
  return !!allowed && allowed.has(fromStatus);
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
    return res.status(400).json({ error: "Invalid id" });
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

  const { data: period, error: pErr } = await admin
    .from("gl_periods")
    .select("id, entity_id, fiscal_year, period_number, status")
    .eq("id", id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: "Period not found" });

  if (period.status === "closed_with_closing_jes") {
    return res.status(409).json({
      error: "Period is closed_with_closing_jes (terminal, set by year-end close). Cannot transition.",
    });
  }

  if (!transitionAllowed(period.status, v.data.target_status)) {
    return res.status(409).json({
      error: `Cannot transition '${period.status}' → '${v.data.target_status}'. Allowed: open→soft_close, soft_close→closed.`,
    });
  }

  // Idempotent no-op (same → same)
  if (period.status === v.data.target_status) {
    return res.status(200).json({
      period_id: id,
      from: period.status,
      to: v.data.target_status,
      idempotent: true,
      message: "Period already in target status; no change applied.",
    });
  }

  // M27 approval gate (opt-in; only fires if an active rule of
  // kind='gl_period_close' exists).
  try {
    const approval = await requestIfRequired(admin, {
      kind: "gl_period_close",
      entity_id: period.entity_id,
      context_table: "gl_periods",
      context_id: period.id,
      amount_cents: null,
      payload: {
        fiscal_year: period.fiscal_year,
        period_number: period.period_number,
        from_status: period.status,
        target_status: v.data.target_status,
        reason: v.data.reason,
      },
      created_by_user_id: v.data.actor_user_id,
    });
    if (approval.required) {
      try {
        await enqueueNotification(admin, {
          entity_id: period.entity_id,
          kind: "gl_period_close_approval_requested",
          severity: "warn",
          subject: `Period close ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} needs approval`,
          body: `Closing ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} from '${period.status}' to '${v.data.target_status}' is pending approval.`,
          context_table: "gl_periods",
          context_id: period.id,
          recipient_roles: ["admin"],
          created_by_user_id: v.data.actor_user_id,
        });
      } catch { /* non-fatal */ }
      return res.status(202).json({
        requires_approval: true,
        approval_request_id: approval.request_id,
      });
    }
  } catch (e) {
    if (e instanceof ApprovalsError) {
      return res.status(500).json({ error: `Approvals gate failed: ${e.message}` });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // Atomic transition via PL/pgSQL RPC — sets session-local vars (so the
  // audit trigger captures actor + reason) AND UPDATEs gl_periods inside
  // the same transaction. A split JS update would land on a different pool
  // connection and the session vars would not carry over.
  const { data: updated, error: upErr } = await admin.rpc("gl_period_transition_status", {
    p_id: id,
    p_target_status: v.data.target_status,
    p_actor_user_id: v.data.actor_user_id,
    p_reason: v.data.reason,
  });
  if (upErr) return res.status(500).json({ error: upErr.message });
  if (!updated) return res.status(500).json({ error: "Transition RPC returned no row" });

  // M28 notification.
  try {
    const notifKind = v.data.target_status === "closed" ? "gl_period_closed" : "gl_period_soft_closed";
    await enqueueNotification(admin, {
      entity_id: period.entity_id,
      kind: notifKind,
      severity: "info",
      subject: `Period ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} is now ${v.data.target_status}`,
      body: `Period ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} transitioned from '${period.status}' to '${v.data.target_status}'${v.data.reason ? `. Reason: ${v.data.reason}` : ""}.`,
      context_table: "gl_periods",
      context_id: period.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id: v.data.actor_user_id,
    });
  } catch { /* non-fatal */ }

  return res.status(200).json({
    period_id: id,
    from: period.status,
    to: updated.status,
    idempotent: false,
    period: updated,
  });
}
