// api/internal/build-orders/[id]/reopen
//
// POST — REOPEN a COMPLETED build (reverse its completion). Moves the finished
//        goods back into WIP so the operator can adjust components / capitalize
//        services / re-complete:
//          1. Reverse the complete JE(s) (DR WIP / CR finished-inventory — the
//             completion's DR finished / CR WIP, undone) on BOTH bases.
//          2. Deplete the finished-goods FIFO layer(s) the completion created.
//          3. Flip the build back to 'issued' (accumulated_cost_cents + WIP
//             intact — completion never zeroed them).
//
//        GUARD: refuses (409) if any finished units were already sold/consumed
//        downstream (a live inventory_consumption draw) — reversing would strand
//        the cost of goods already shipped. Reverse those sales first.
//
// Reversing GL requires a T11 reason — REQUIRED on this endpoint.
// Body: { reason (required), actor_user_id? }.

import { UUID_RE, corsHeaders, client, resolveDefaultEntityId } from "./_shared.js";
import { reverseCompletedBuild, ReversalError } from "./_reversal.js";
import { extractActorFromRequest, requireReason } from "../../../_lib/audit/withAuditContext.js";

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

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status !== "completed") {
    return res.status(409).json({ error: `Build is '${build.status}', not completed — only a completed build can be reopened.` });
  }

  // Reversing GL requires a T11 reason.
  const reasonGate = requireReason("REVERSE", reason);
  if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

  const actor = await extractActorFromRequest(req, admin);
  const correlation_id = req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;
  const auditCtx = { reason, actor, source: "manual", correlation_id, created_by_user_id: actorUserId || actor?.auth_id || null };

  let result;
  try {
    result = await reverseCompletedBuild(admin, entity.id, build, auditCtx);
  } catch (e) {
    if (e instanceof ReversalError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // Flip completed → issued. accumulated_cost_cents / wip / issue_je_id are left
  // intact so the operator can re-complete; clear the completion stamps.
  const patch = {
    status: "issued",
    completed_qty: 0,
    complete_je_id: null,
    finished_unit_cost_cents: null,
    updated_at: new Date().toISOString(),
    notes: build.notes ? `${build.notes}\n[reopened] ${reason}` : `[reopened] ${reason}`,
  };
  const { data: updated, error: upErr } = await admin.from("mfg_build_orders")
    .update(patch).eq("id", id).eq("status", "completed").select().single();
  if (upErr) {
    return res.status(500).json({ error: `Completion reversed (${result.reversed_je_ids.length} JE(s), ${result.depleted_qty} unit(s) depleted) but failed to flip build to issued: ${upErr.message}` });
  }

  return res.status(200).json({
    ...updated,
    reversed_je_ids: result.reversed_je_ids,
    depleted_qty: result.depleted_qty,
    layers_deleted: result.layers_deleted,
    layers_zeroed: result.layers_zeroed,
  });
}
