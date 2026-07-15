// api/internal/build-orders/_reversal.js
//
// Shared reversal helpers for manufacturing build orders. These back three
// operator actions on a build:
//
//   • CANCEL an issued build   (cancel.js)             — reverse issue + service
//     + CMT-accrual JEs, restore the consumed part/style FIFO units.
//   • REOPEN a completed build (reopen.js)             — reverse the complete JE
//     (WIP → finished-goods) and DEPLETE the finished-goods FIFO layer(s) it
//     created, putting the build back to 'issued' with WIP + accumulated cost
//     intact so the operator can adjust and re-complete.
//   • DELETE a build (full unwind, cancel.js)          — reopen (if completed)
//     THEN the issued reversal THEN flip to 'cancelled'.
//
// All GL reversals go through reverseJeWithAudit (T11-safe — a reason travels in
// the same statement as each write). All restores/depletions are idempotent and
// multi-statement (the codebase's accepted "FIFO ledger may lag GL by one event"
// tradeoff); a re-run after a partial failure is a no-op on the parts already
// done.
//
// Helper file (underscore-prefixed) — imported, never routed.

import { reverseJeWithAudit } from "../../../_lib/accounting/reverseJeWithAudit.js";
import { restoreBuildStyleConsumption, restoreBuildPartConsumption } from "../../../_lib/inventory/restoreBuildConsumption.js";

// ── JE gathering ─────────────────────────────────────────────────────────────

// Every posted JE the ISSUE side of a build owns: the issue entry (source_id =
// build), each capitalized-service entry (source_id = the service component id),
// and any CMT accrual (source_id = build). Both bases (ACCRUAL + CASH) are
// separate rows and each is reversed by the caller.
export async function gatherIssueJeIds(admin, buildId) {
  const { data: svcComps } = await admin
    .from("mfg_build_components").select("id").eq("build_order_id", buildId).eq("component_kind", "service");
  const svcCompIds = (svcComps || []).map((c) => c.id);

  const issueJeQ = admin.from("journal_entries").select("id")
    .eq("source_table", "mfg_build_issue").eq("source_id", buildId).eq("status", "posted");
  const svcJeQ = svcCompIds.length
    ? admin.from("journal_entries").select("id").eq("source_table", "mfg_build_service").in("source_id", svcCompIds).eq("status", "posted")
    : Promise.resolve({ data: [] });
  const cmtJeQ = admin.from("journal_entries").select("id")
    .eq("source_table", "mfg_cmt_accrual").eq("source_id", buildId).eq("status", "posted");

  const [{ data: issueJes }, { data: svcJes }, { data: cmtJes }] = await Promise.all([issueJeQ, svcJeQ, cmtJeQ]);
  return [...(issueJes || []), ...(svcJes || []), ...(cmtJes || [])].map((r) => r.id);
}

// The complete JEs (WIP → finished goods). source_table='mfg_build_complete',
// source_id = build. Both bases are separate posted rows.
export async function gatherCompleteJeIds(admin, buildId) {
  const { data: jes } = await admin
    .from("journal_entries").select("id")
    .eq("source_table", "mfg_build_complete").eq("source_id", buildId).eq("status", "posted");
  return (jes || []).map((r) => r.id);
}

// Reverse each JE in order via the T11-safe helper. Idempotent: an
// already-reversed JE returns null and is skipped. Throws on the first genuine
// failure so the caller can bail BEFORE it mutates any inventory.
export async function reverseJes(admin, jeIds, auditCtx) {
  const reversedJeIds = [];
  for (const jeId of jeIds) {
    const newId = await reverseJeWithAudit(admin, jeId, auditCtx);
    if (newId) reversedJeIds.push(newId);
  }
  return reversedJeIds;
}

// ── Issued-side inventory + component reset (shared by cancel + delete) ───────

export async function restoreIssuedConsumption(admin, buildId, actorUserId) {
  let style = { restored_qty: 0, rows_reversed: 0 };
  let part = { restored_qty: 0, rows_reversed: 0 };
  try { style = await restoreBuildStyleConsumption(admin, buildId, actorUserId); }
  catch (e) { console.warn("[build-reversal] style restore failed:", e instanceof Error ? e.message : String(e)); }
  try { part = await restoreBuildPartConsumption(admin, buildId, actorUserId); }
  catch (e) { console.warn("[build-reversal] part restore failed:", e instanceof Error ? e.message : String(e)); }
  return { style, part };
}

export async function zeroIssuedBuildComponents(admin, buildId) {
  await admin.from("mfg_build_components")
    .update({ qty_consumed: 0, actual_cost_cents: 0 })
    .eq("build_order_id", buildId).in("component_kind", ["part", "finished_style"]);
  await admin.from("mfg_build_components")
    .update({ service_capitalized: false, actual_cost_cents: 0 })
    .eq("build_order_id", buildId).eq("component_kind", "service");
}

// ── Finished-goods layer depletion (reverse-complete) ────────────────────────

// Find the finished-goods FIFO layer(s) a completed build created, and decide
// whether they can be depleted. A build's manufacture layers are found by
// source_adjustment_id = build (new linkage) OR by the notes handle
// `Manufacturing build <build_number|id>` (legacy layers pre-linkage).
//
// GUARD: a layer is BLOCKED from reversal if any of its units were consumed
// downstream and that draw is still LIVE (inventory_consumption.reversed_at IS
// NULL) — reversing would strand the cost of goods already sold/shipped. A
// zeroed zombie layer from a prior reverse-complete (remaining_qty=0, no live
// draw) is NOT blocked, so the whole thing stays idempotent.
//
// Returns { layers, layerIds, blocked, blockedLayerIds, depletableQty }.
export async function planFinishedLayerDepletion(admin, entityId, build) {
  const buildId = build.id;
  const handle = `Manufacturing build ${build.build_number || buildId}`;

  const byAdj = admin.from("inventory_layers")
    .select("id, item_id, original_qty, remaining_qty, notes")
    .eq("entity_id", entityId).eq("source_kind", "manufacture").eq("source_adjustment_id", buildId);
  const byNote = admin.from("inventory_layers")
    .select("id, item_id, original_qty, remaining_qty, notes")
    .eq("entity_id", entityId).eq("source_kind", "manufacture").is("source_adjustment_id", null).eq("notes", handle);

  const [{ data: adjLayers }, { data: noteLayers }] = await Promise.all([byAdj, byNote]);
  const byId = new Map();
  for (const l of [...(adjLayers || []), ...(noteLayers || [])]) byId.set(l.id, l);
  const layers = [...byId.values()];
  const layerIds = layers.map((l) => l.id);

  if (layerIds.length === 0) {
    return { layers: [], layerIds: [], blocked: false, blockedLayerIds: [], depletableQty: 0 };
  }

  // Live downstream draws against any of these layers → blocked.
  const { data: liveDraws } = await admin
    .from("inventory_consumption")
    .select("layer_id")
    .in("layer_id", layerIds)
    .is("reversed_at", null);
  const blockedLayerIds = [...new Set((liveDraws || []).map((d) => d.layer_id))];

  const depletableQty = layers.reduce((s, l) => s + (Number(l.remaining_qty) || 0), 0);

  return {
    layers,
    layerIds,
    blocked: blockedLayerIds.length > 0,
    blockedLayerIds,
    depletableQty,
  };
}

// Deplete the finished-goods layers a plan identified. Callers MUST have checked
// plan.blocked === false first. Each layer with NO consumption rows at all is
// hard-deleted (clean unwind); one that carries only REVERSED draws is zeroed
// instead (its append-only consumption rows FK-restrict a delete). Idempotent:
// an already-zeroed / already-gone layer is a no-op.
//
// Returns { depleted_qty, layers_deleted, layers_zeroed }.
export async function depleteFinishedLayers(admin, plan) {
  let depletedQty = 0, layersDeleted = 0, layersZeroed = 0;
  if (!plan || plan.layerIds.length === 0) return { depleted_qty: 0, layers_deleted: 0, layers_zeroed: 0 };

  // Which layers carry ANY consumption row (live or reversed)? Those can't be
  // hard-deleted (FK RESTRICT on inventory_consumption.layer_id).
  const { data: anyDraws } = await admin
    .from("inventory_consumption").select("layer_id").in("layer_id", plan.layerIds);
  const hasDraws = new Set((anyDraws || []).map((d) => d.layer_id));

  for (const layer of plan.layers) {
    depletedQty += Number(layer.remaining_qty) || 0;
    if (hasDraws.has(layer.id)) {
      await admin.from("inventory_layers")
        .update({ remaining_qty: 0, notes: `${layer.notes || ""} [reverse-complete depleted]`.trim() })
        .eq("id", layer.id);
      layersZeroed += 1;
    } else {
      const { error } = await admin.from("inventory_layers").delete().eq("id", layer.id);
      if (error) {
        // Fall back to zeroing if a delete is refused (e.g. a draw raced in).
        await admin.from("inventory_layers").update({ remaining_qty: 0 }).eq("id", layer.id);
        layersZeroed += 1;
      } else {
        layersDeleted += 1;
      }
    }
  }
  return { depleted_qty: depletedQty, layers_deleted: layersDeleted, layers_zeroed: layersZeroed };
}

// ── Reverse-complete orchestration ───────────────────────────────────────────

export class ReversalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Reverse a COMPLETED build back to 'issued':
//   1. Guard — refuse if any finished units were consumed downstream (live).
//   2. Reverse the complete JE(s) (WIP ← finished-goods dollars).
//   3. Deplete the finished-goods FIFO layer(s) (units removed).
//   4. Patch the build back to 'issued' (WIP + accumulated_cost_cents intact —
//      completion never zeroed them — so the operator can re-complete).
//
// Throws ReversalError(409/500) on a guard failure or a mid-way JE failure
// (before any inventory mutation). Returns
// { reversed_je_ids, depleted_qty, layers_deleted, layers_zeroed }.
export async function reverseCompletedBuild(admin, entityId, build, auditCtx) {
  // 1. Guard BEFORE touching GL.
  const plan = await planFinishedLayerDepletion(admin, entityId, build);
  if (plan.blocked) {
    throw new ReversalError(
      409,
      `Cannot reverse completion of ${build.build_number}: ${plan.blockedLayerIds.length} finished-goods layer(s) have units already sold/consumed downstream. Reverse those sales/consumption first.`,
    );
  }

  // 2. Reverse the complete JE(s). If a reversal fails, nothing else has run.
  const jeIds = await gatherCompleteJeIds(admin, build.id);
  let reversedJeIds;
  try {
    reversedJeIds = await reverseJes(admin, jeIds, auditCtx);
  } catch (e) {
    throw new ReversalError(500, `Complete-JE reversal failed: ${e instanceof Error ? e.message : String(e)}. No inventory was depleted; the build is unchanged — retry.`);
  }

  // 3. Deplete the finished-goods layers (best-effort, idempotent).
  let dep = { depleted_qty: 0, layers_deleted: 0, layers_zeroed: 0 };
  try { dep = await depleteFinishedLayers(admin, plan); }
  catch (e) { console.warn("[reverse-complete] layer depletion failed:", e instanceof Error ? e.message : String(e)); }

  // 4. Drop the recorded per-size outputs (re-completion re-derives them) and
  //    put the build back to 'issued' with WIP intact.
  await admin.from("mfg_build_outputs").delete().eq("build_order_id", build.id);

  return { reversed_je_ids: reversedJeIds, ...dep };
}
