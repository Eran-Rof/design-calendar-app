// api/_lib/approvals/index.js
//
// Tangerine M27 Workflow/Approvals — public entrypoint.
//
//   approvalsAPI.requestIfRequired({...})  — call from a posting handler;
//      returns { required: false } if no rule matched, or
//      { required: true, request_id, current_step } otherwise (and creates
//      the approval_requests row + steps).
//
//   approvalsAPI.decide({ request_id, step_id, decision, notes }, { actor_user_id })
//      — record an approve/reject/request_changes on a step. Auto-promotes
//      the request to status='approved' when the last open step closes, or
//      to status='rejected' on the first 'reject' decision.
//
//   approvalsAPI.cancel({ request_id }, { actor_user_id }) — owner/admin
//      cancellation. Sets status='cancelled' + final_decided_at.
//
// Loose coupling: callers pass (context_table, context_id) and a payload.
// approval_requests does NOT carry an FK to the source row — the request can
// outlive deletes/edits because payload snapshots the requesting context.
//
// Per docs/tangerine/P2-cross-cutters-architecture.md §4.

import { resolveSteps } from "./matcher.js";
import { validateRule } from "./schema.js";

export { matchesRule, resolveSteps } from "./matcher.js";
export { validateRule, validateMatch, validateSteps } from "./schema.js";

export class ApprovalsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Called by downstream module handlers BEFORE posting a row.
 *
 * @param {Object} supabase           Service-role client
 * @param {Object} ctx
 * @param {string} ctx.kind           e.g. 'ap_invoice', 'je_post', 'po_release'
 * @param {string} ctx.entity_id
 * @param {string} ctx.context_table
 * @param {string} ctx.context_id
 * @param {number} [ctx.amount_cents] Drives min/max_amount_cents matchers
 * @param {string} [ctx.currency]     Default 'USD'
 * @param {string} [ctx.source_kind]
 * @param {boolean} [ctx.vendor_new]
 * @param {Object} [ctx.payload]      Snapshot of requesting row, audit only
 * @param {string} [ctx.created_by_user_id]
 * @returns {Promise<{required:false}|{required:true,request_id:string,current_step:Object}>}
 */
export async function requestIfRequired(supabase, ctx) {
  if (!supabase) throw new ApprovalsError("missing_client", "supabase client required");
  if (!ctx || typeof ctx !== "object") {
    throw new ApprovalsError("invalid_ctx", "ctx must be an object");
  }
  if (!ctx.kind) throw new ApprovalsError("missing_kind", "ctx.kind is required");
  if (!ctx.entity_id) throw new ApprovalsError("missing_entity_id", "ctx.entity_id is required");
  if (!ctx.context_table) throw new ApprovalsError("missing_context_table", "ctx.context_table is required");
  if (!ctx.context_id) throw new ApprovalsError("missing_context_id", "ctx.context_id is required");

  // 1. Pull active rules for this (entity, kind)
  const { data: rules, error: rulesErr } = await supabase
    .from("approval_rules")
    .select("id, match, steps")
    .eq("entity_id", ctx.entity_id)
    .eq("kind", ctx.kind)
    .eq("is_active", true);

  if (rulesErr) {
    throw new ApprovalsError("rules_query_failed", `approval_rules query failed: ${rulesErr.message}`, rulesErr);
  }

  const { matched, steps } = resolveSteps(rules || [], ctx);
  if (matched.length === 0) {
    return { required: false };
  }

  // 2. Create approval_requests + steps
  const { data: reqRow, error: reqErr } = await supabase
    .from("approval_requests")
    .insert({
      entity_id: ctx.entity_id,
      kind: ctx.kind,
      context_table: ctx.context_table,
      context_id: ctx.context_id,
      requested_amount_cents: ctx.amount_cents ?? null,
      currency: ctx.currency || "USD",
      status: "pending",
      payload: ctx.payload || {},
      created_by_user_id: ctx.created_by_user_id || null,
    })
    .select("id")
    .single();

  if (reqErr) {
    throw new ApprovalsError("request_insert_failed", `approval_requests insert failed: ${reqErr.message}`, reqErr);
  }

  const stepRows = steps.map((s) => ({
    request_id: reqRow.id,
    step_order: s.step_order,
    mode: s.mode,
    role_required: s.role_required,
  }));

  const { error: stepsErr } = await supabase
    .from("approval_request_steps")
    .insert(stepRows);

  if (stepsErr) {
    // Roll back the request row to avoid an orphan in 'pending'
    await supabase.from("approval_requests").delete().eq("id", reqRow.id);
    throw new ApprovalsError("steps_insert_failed", `approval_request_steps insert failed: ${stepsErr.message}`, stepsErr);
  }

  return {
    required: true,
    request_id: reqRow.id,
    current_step: { ...stepRows[0] },
  };
}

/**
 * Record a decision on a specific step.
 *
 * Behavior:
 *   - decision='approve' on a step's mode='any' → marks step fulfilled by actor
 *   - decision='approve' on a step's mode='all' → records decision in
 *     approval_decisions and marks step fulfilled iff EVERY entity_users row
 *     for (entity_id, role_required) has decided 'approve' (one decision per
 *     unique actor).
 *   - decision='reject' → flips request status='rejected' + final_decided_at
 *   - decision='request_changes' → records in approval_decisions but does not
 *     change step.fulfilled_at; downstream code typically opens a new request
 *     after the change.
 *   - When the LAST step's last requirement closes, request status='approved'.
 *
 * Returns the updated request + a finalized flag.
 */
export async function decide(supabase, { request_id, step_id, decision, notes }, { actor_user_id }) {
  if (!supabase) throw new ApprovalsError("missing_client", "supabase client required");
  if (!request_id) throw new ApprovalsError("missing_request_id", "request_id required");
  if (!step_id) throw new ApprovalsError("missing_step_id", "step_id required");
  if (!actor_user_id) throw new ApprovalsError("missing_actor", "actor_user_id required");
  if (!["approve", "reject", "request_changes"].includes(decision)) {
    throw new ApprovalsError("invalid_decision", "decision must be approve|reject|request_changes");
  }

  const { data: request, error: reqErr } = await supabase
    .from("approval_requests")
    .select("id, entity_id, status, created_by_user_id")
    .eq("id", request_id)
    .single();
  if (reqErr || !request) {
    throw new ApprovalsError("request_not_found", `request ${request_id} not found`);
  }
  if (request.status !== "pending") {
    throw new ApprovalsError("request_not_pending",
      `request status is ${request.status} (must be pending)`);
  }

  // Segregation of duties: the maker may not be the checker. The person who
  // created the request cannot APPROVE it — that inequality (created_by ≠
  // approver) IS the maker-checker control. They may still 'reject' or
  // 'request_changes' their own request (i.e. withdraw), and cancel() has its
  // own owner rule.
  if (
    decision === "approve" &&
    request.created_by_user_id &&
    request.created_by_user_id === actor_user_id
  ) {
    throw new ApprovalsError(
      "self_approval_forbidden",
      "segregation of duties: the requester cannot approve their own request — a different approver is required",
    );
  }

  const { data: step, error: stepErr } = await supabase
    .from("approval_request_steps")
    .select("id, request_id, step_order, mode, role_required, fulfilled_at")
    .eq("id", step_id)
    .eq("request_id", request_id)
    .single();
  if (stepErr || !step) {
    throw new ApprovalsError("step_not_found", `step ${step_id} not found in request ${request_id}`);
  }
  if (step.fulfilled_at) {
    throw new ApprovalsError("step_already_fulfilled", `step ${step_id} already fulfilled`);
  }

  // Enforce step-order: previous steps must be fulfilled
  const { data: priorOpen, error: priorErr } = await supabase
    .from("approval_request_steps")
    .select("id")
    .eq("request_id", request_id)
    .lt("step_order", step.step_order)
    .is("fulfilled_at", null)
    .limit(1);
  if (priorErr) {
    throw new ApprovalsError("prior_query_failed", priorErr.message);
  }
  if (priorOpen && priorOpen.length > 0) {
    throw new ApprovalsError("prior_steps_open", "previous steps must be fulfilled first");
  }

  // Caller's role-check: actor must hold step.role_required for this entity.
  const { data: entityUser, error: euErr } = await supabase
    .from("entity_users")
    .select("role")
    .eq("auth_id", actor_user_id)
    .eq("entity_id", request.entity_id)
    .maybeSingle();
  if (euErr) {
    throw new ApprovalsError("role_check_failed", euErr.message);
  }
  if (!entityUser || entityUser.role !== step.role_required) {
    throw new ApprovalsError("actor_role_mismatch",
      `actor must have role ${step.role_required} in entity ${request.entity_id}`);
  }

  // Append-only decision log
  const { error: decErr } = await supabase.from("approval_decisions").insert({
    request_id,
    step_id,
    decision,
    decided_by_user_id: actor_user_id,
    notes: notes || null,
  });
  if (decErr) {
    throw new ApprovalsError("decision_insert_failed", decErr.message);
  }

  // Reject → terminal
  if (decision === "reject") {
    const { data: updated, error: upErr } = await supabase
      .from("approval_requests")
      .update({ status: "rejected", final_decided_at: new Date().toISOString() })
      .eq("id", request_id)
      .select()
      .single();
    if (upErr) throw new ApprovalsError("request_update_failed", upErr.message);
    return { request: updated, finalized: true };
  }

  // request_changes → log only; caller decides next move (typically cancel + reopen)
  if (decision === "request_changes") {
    return { request, finalized: false };
  }

  // approve: close step if mode='any', or check 'all'-quorum
  if (step.mode === "all") {
    // count distinct approvers for this step with decision='approve'
    const { data: approverRows, error: appErr } = await supabase
      .from("approval_decisions")
      .select("decided_by_user_id")
      .eq("step_id", step_id)
      .eq("decision", "approve");
    if (appErr) throw new ApprovalsError("approvers_query_failed", appErr.message);
    const distinctApprovers = new Set((approverRows || []).map((r) => r.decided_by_user_id));

    const { data: roleHolders, error: rhErr } = await supabase
      .from("entity_users")
      .select("auth_id")
      .eq("entity_id", request.entity_id)
      .eq("role", step.role_required);
    if (rhErr) throw new ApprovalsError("role_holders_query_failed", rhErr.message);
    const totalHolders = new Set((roleHolders || []).map((r) => r.auth_id));

    const quorumMet =
      totalHolders.size > 0 &&
      [...totalHolders].every((uid) => distinctApprovers.has(uid));
    if (!quorumMet) {
      return { request, finalized: false };
    }
  }

  // Mark this step fulfilled
  const nowIso = new Date().toISOString();
  const { error: stepUpErr } = await supabase
    .from("approval_request_steps")
    .update({ fulfilled_at: nowIso, fulfilled_by_user_id: actor_user_id })
    .eq("id", step_id);
  if (stepUpErr) throw new ApprovalsError("step_update_failed", stepUpErr.message);

  // Any more open steps? If not, request is approved.
  const { data: openLeft, error: openErr } = await supabase
    .from("approval_request_steps")
    .select("id")
    .eq("request_id", request_id)
    .is("fulfilled_at", null)
    .limit(1);
  if (openErr) throw new ApprovalsError("open_left_query_failed", openErr.message);

  if (!openLeft || openLeft.length === 0) {
    const { data: updated, error: finUpErr } = await supabase
      .from("approval_requests")
      .update({ status: "approved", final_decided_at: nowIso })
      .eq("id", request_id)
      .select()
      .single();
    if (finUpErr) throw new ApprovalsError("request_update_failed", finUpErr.message);
    return { request: updated, finalized: true };
  }

  return { request, finalized: false };
}

/**
 * Cancel a pending request. Owner of the request OR an admin can cancel.
 */
export async function cancel(supabase, { request_id }, { actor_user_id }) {
  if (!supabase) throw new ApprovalsError("missing_client", "supabase client required");
  if (!request_id) throw new ApprovalsError("missing_request_id", "request_id required");
  if (!actor_user_id) throw new ApprovalsError("missing_actor", "actor_user_id required");

  const { data: request, error: reqErr } = await supabase
    .from("approval_requests")
    .select("id, entity_id, status, created_by_user_id")
    .eq("id", request_id)
    .single();
  if (reqErr || !request) {
    throw new ApprovalsError("request_not_found", `request ${request_id} not found`);
  }
  if (request.status !== "pending") {
    throw new ApprovalsError("request_not_pending",
      `request status is ${request.status} (must be pending to cancel)`);
  }

  // Authorization: owner or admin on this entity
  if (request.created_by_user_id !== actor_user_id) {
    const { data: actorRow, error: actorErr } = await supabase
      .from("entity_users")
      .select("role")
      .eq("auth_id", actor_user_id)
      .eq("entity_id", request.entity_id)
      .maybeSingle();
    if (actorErr) throw new ApprovalsError("actor_query_failed", actorErr.message);
    if (!actorRow || actorRow.role !== "admin") {
      throw new ApprovalsError("not_authorized",
        "actor not authorized: only request owner or admin may cancel");
    }
  }

  const { data: updated, error: upErr } = await supabase
    .from("approval_requests")
    .update({ status: "cancelled", final_decided_at: new Date().toISOString() })
    .eq("id", request_id)
    .select()
    .single();
  if (upErr) throw new ApprovalsError("request_update_failed", upErr.message);
  return { request: updated };
}
