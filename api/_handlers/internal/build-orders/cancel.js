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
//   • completed         → blocked (WIP already moved to finished goods; needs a
//                          separate reverse-complete path).
//
// Reversing GL requires a T11 reason (D3): 'reason' is REQUIRED for an issued
// build (postings to reverse) and optional for draft/released.
//
// Body: { reason?, actor_user_id? }.

import { UUID_RE, corsHeaders, client, resolveDefaultEntityId } from "./_shared.js";
import { reverseJeWithAudit } from "../../../_lib/accounting/reverseJeWithAudit.js";
import { restoreBuildStyleConsumption, restoreBuildPartConsumption } from "../../../_lib/inventory/restoreBuildConsumption.js";
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

  if (build.status === "cancelled") return res.status(409).json({ error: "Build is already cancelled" });
  if (build.status === "completed") {
    return res.status(409).json({ error: "Cannot cancel a completed build — its WIP already moved to finished goods. Reverse the completion first." });
  }

  // ── Draft / released: nothing posted → just cancel. ──────────────────────────
  if (build.status === "draft" || build.status === "released") {
    const patch = { status: "cancelled", updated_at: new Date().toISOString() };
    if (reason) patch.notes = build.notes ? `${build.notes}\n[cancelled] ${reason}` : `[cancelled] ${reason}`;
    const { data: updated, error } = await admin.from("mfg_build_orders").update(patch).eq("id", id).eq("status", build.status).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ...updated, reversed_je_ids: [], restored_style_qty: 0, restored_part_qty: 0 });
  }

  // ── Issued: full reversal. Requires a T11 reason (GL will be reversed). ───────
  const reasonGate = requireReason("REVERSE", reason);
  if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

  const actor = await extractActorFromRequest(req, admin);
  const correlation_id = req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;
  const auditCtx = { reason, actor, source: "manual", correlation_id, created_by_user_id: actorUserId || actor?.auth_id || null };

  // Gather every posted JE this build owns: the issue entries (source_id = build)
  // and each capitalized-service entry (source_id = the service component id).
  // Both bases (ACCRUAL + CASH) are separate rows and each is reversed.
  const { data: svcComps } = await admin
    .from("mfg_build_components").select("id").eq("build_order_id", id).eq("component_kind", "service");
  const svcCompIds = (svcComps || []).map((c) => c.id);

  const issueJeQ = admin.from("journal_entries").select("id")
    .eq("source_table", "mfg_build_issue").eq("source_id", id).eq("status", "posted");
  const svcJeQ = svcCompIds.length
    ? admin.from("journal_entries").select("id").eq("source_table", "mfg_build_service").in("source_id", svcCompIds).eq("status", "posted")
    : Promise.resolve({ data: [] });
  // Capitalize-mode: a CMT accrual (DR WIP / CR 2160) may have posted at receipt
  // before completion failed, leaving the build 'issued'. Reverse it too.
  const cmtJeQ = admin.from("journal_entries").select("id")
    .eq("source_table", "mfg_cmt_accrual").eq("source_id", id).eq("status", "posted");
  const [{ data: issueJes }, { data: svcJes }, { data: cmtJes }] = await Promise.all([issueJeQ, svcJeQ, cmtJeQ]);
  const jeIds = [...(issueJes || []), ...(svcJes || []), ...(cmtJes || [])].map((r) => r.id);

  const reversedJeIds = [];
  try {
    for (const jeId of jeIds) {
      const newId = await reverseJeWithAudit(admin, jeId, auditCtx);
      if (newId) reversedJeIds.push(newId);
    }
  } catch (e) {
    // A reversal failed mid-way. Leave the build 'issued' (not flipped) so the
    // operator can retry — the reverse helper is idempotent (already-reversed
    // JEs return null) and the restores below have not run yet.
    return res.status(500).json({ error: `GL reversal failed: ${e instanceof Error ? e.message : String(e)}. No inventory was restored; the build is unchanged — retry.` });
  }

  // Put the physical units back (parts + styles). Best-effort per the accepted
  // "FIFO may lag GL" tradeoff; each is idempotent.
  let style = { restored_qty: 0, rows_reversed: 0 };
  let part = { restored_qty: 0, rows_reversed: 0 };
  try { style = await restoreBuildStyleConsumption(admin, id, actorUserId); }
  catch (e) { console.warn("[build-cancel] style restore failed:", e instanceof Error ? e.message : String(e)); }
  try { part = await restoreBuildPartConsumption(admin, id, actorUserId); }
  catch (e) { console.warn("[build-cancel] part restore failed:", e instanceof Error ? e.message : String(e)); }

  // Zero the WIP + unstamp the components, flip to cancelled.
  await admin.from("mfg_build_components")
    .update({ qty_consumed: 0, actual_cost_cents: 0 })
    .eq("build_order_id", id).in("component_kind", ["part", "finished_style"]);
  await admin.from("mfg_build_components")
    .update({ service_capitalized: false, actual_cost_cents: 0 })
    .eq("build_order_id", id).eq("component_kind", "service");

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
  });
}
