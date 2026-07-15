// api/internal/build-orders/[id]/cancel
//
// POST — cancel a build order, fully reversing whatever it has posted.
//
//   • draft / released  → nothing posted yet; just flip to 'cancelled'.
//   • issued            → REVERSE everything the issue did:
//       1. Reverse the issue JE(s) (DR WIP / CR inventory → undone) — both the
//          ACCRUAL and CASH basis entries.
//       2. Reverse every capitalized service JE (DR WIP / CR AP → undone).
//       3. Restore the FIFO units the issue consumed — parts back to
//          part_inventory_layers, styles back to inventory_layers (the GL
//          reversal only restores the asset DOLLARS; these put the UNITS back).
//       4. Zero the build's WIP (accumulated_cost_cents), unstamp components,
//          and flip to 'cancelled'.
//   • completed         → FULL UNWIND (delete a completed build): first REVERSE
//          THE COMPLETION (WIP ← finished goods; deplete the finished-goods FIFO
//          layer[s]) so the build is back to 'issued', then run the issued
//          reversal above, then flip to 'cancelled'. Blocked (409) if any
//          finished units were already sold/consumed downstream.
//
// Reversing GL requires a T11 reason (D3): 'reason' is REQUIRED whenever there
// are postings to reverse (issued or completed) and optional for draft/released.
//
// Body: { reason?, actor_user_id? }.

import { UUID_RE, corsHeaders, client, resolveDefaultEntityId } from "./_shared.js";
import { extractActorFromRequest, requireReason } from "../../../_lib/audit/withAuditContext.js";
import {
  gatherIssueJeIds, reverseJes, restoreIssuedConsumption, zeroIssuedBuildComponents,
  reverseCompletedBuild, ReversalError,
} from "./_reversal.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const reason = body.reason ? String(body.reason).trim() : null;
  const actorUserId = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  let { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status === "cancelled") return res.status(409).json({ error: "Build is already cancelled" });

  // ── Draft / released: nothing posted → just cancel. ──────────────────────────
  if (build.status === "draft" || build.status === "released") {
    const patch = { status: "cancelled", updated_at: new Date().toISOString() };
    if (reason) patch.notes = build.notes ? `${build.notes}\n[cancelled] ${reason}` : `[cancelled] ${reason}`;
    const { data: updated, error } = await admin.from("mfg_build_orders").update(patch).eq("id", id).eq("status", build.status).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ...updated, reversed_je_ids: [], restored_style_qty: 0, restored_part_qty: 0, depleted_qty: 0 });
  }

  // ── Issued or completed: full reversal. Requires a T11 reason. ───────────────
  const reasonGate = requireReason("REVERSE", reason);
  if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

  const actor = await extractActorFromRequest(req, admin);
  const correlation_id = req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;
  const auditCtx = { reason, actor, source: "manual", correlation_id, created_by_user_id: actorUserId || actor?.auth_id || null };

  const reversedJeIds = [];
  let depletedQty = 0;

  // ── Completed: reverse the completion FIRST (WIP ← finished goods), which puts
  //    the build back to 'issued', then fall through to the issued reversal. ───
  if (build.status === "completed") {
    let rc;
    try {
      rc = await reverseCompletedBuild(admin, entity.id, build, auditCtx);
    } catch (e) {
      if (e instanceof ReversalError) return res.status(e.status).json({ error: e.message });
      return res.status(500).json({ error: `Completion reversal failed: ${e instanceof Error ? e.message : String(e)}. The build is unchanged — retry.` });
    }
    reversedJeIds.push(...rc.reversed_je_ids);
    depletedQty = rc.depleted_qty;
    // Move to 'issued' so the rest of the unwind (and its optimistic status
    // guard) operates on a consistent state.
    await admin.from("mfg_build_orders")
      .update({ status: "issued", completed_qty: 0, complete_je_id: null, finished_unit_cost_cents: null, updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "completed");
    const { data: refetched } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
    if (refetched) build = refetched;
  }

  // ── Issued reversal (also the second half of a completed-build unwind). ──────
  const jeIds = await gatherIssueJeIds(admin, id);
  try {
    reversedJeIds.push(...await reverseJes(admin, jeIds, auditCtx));
  } catch (e) {
    // A reversal failed mid-way. Leave the build 'issued' (not flipped) so the
    // operator can retry — reverseJes is idempotent (already-reversed JEs are
    // skipped) and the restores below have not run yet.
    return res.status(500).json({ error: `GL reversal failed: ${e instanceof Error ? e.message : String(e)}. No inventory was restored; the build is at 'issued' — retry.` });
  }

  // Put the physical units back (parts + styles). Best-effort + idempotent.
  const { style, part } = await restoreIssuedConsumption(admin, id, actorUserId);

  // Zero the WIP + unstamp the components, flip to cancelled.
  await zeroIssuedBuildComponents(admin, id);

  const patch = {
    status: "cancelled",
    accumulated_cost_cents: 0,
    issue_je_id: null,
    cmt_accrued_cents: 0,
    cmt_accrual_je_id: null,
    updated_at: new Date().toISOString(),
    notes: build.notes ? `${build.notes}\n[cancelled] ${reason}` : `[cancelled] ${reason}`,
  };
  const { data: updated, error: upErr } = await admin.from("mfg_build_orders")
    .update(patch).eq("id", id).eq("status", "issued").select().single();
  if (upErr) {
    return res.status(500).json({ error: `Reversals + restores done (${reversedJeIds.length} JE(s)) but failed to flip build to cancelled: ${upErr.message}` });
  }

  return res.status(200).json({
    ...updated,
    reversed_je_ids: reversedJeIds,
    restored_style_qty: style.restored_qty,
    restored_part_qty: part.restored_qty,
    depleted_qty: depletedQty,
  });
}
