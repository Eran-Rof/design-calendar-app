// api/internal/build-orders/[id]/complete
//
// POST — complete a build: move accumulated WIP into finished-goods inventory
//        (mfg_build_complete). Creates the finished style's FIFO layer at the
//        actual accumulated build cost and posts DR finished-inventory / CR WIP.
//        Body: { completed_qty? (defaults to target_qty), actor_user_id? }.
//
// This is the MANUAL completion path. The PO-driven path (receiving the finished
// good against a conversion PO) is wired in M5 and calls the same event.

import { postEvent } from "../../../_lib/accounting/posting/index.js";
import { resolveOrCreateSku } from "../../../_lib/styleMatrix.js";
import { UUID_RE, corsHeaders, client, resolveDefaultEntityId, resolveFinishedInventoryAccount, todayISO } from "./_shared.js";

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
  const actorUserId = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status !== "issued") return res.status(409).json({ error: `Build is '${build.status}', not issued — issue components / capitalize services first.` });
  const accum = Number(build.accumulated_cost_cents || 0);
  if (accum <= 0) return res.status(400).json({ error: "Accumulated WIP cost is 0 — nothing to move to finished goods." });

  // Phase A — per-SIZE outputs. body.outputs = [{ size, color?, qty, item_id? }].
  // When supplied, each output resolves to (or auto-creates) the per-size
  // ip_item_master SKU of the finished STYLE (same resolver SO/PO entry uses),
  // and completed_qty = the matrix total. mfgBuildComplete then lands one
  // finished-goods layer + one GL debit per size. Absent → single-item path.
  let resolvedOutputs = null;
  if (Array.isArray(body.outputs) && body.outputs.length > 0) {
    const { data: fin } = await admin.from("ip_item_master").select("id, style_id, style_code, color").eq("id", build.finished_item_id).maybeSingle();
    // Prefer the build's own finished_style_id (set when a style was picked);
    // fall back to the representative finished item's style.
    const styleId = build.finished_style_id || fin?.style_id || null;
    if (!styleId) return res.status(400).json({ error: "This build has no finished style, so a size matrix can't be resolved. Complete without a matrix." });
    let styleCode = fin?.style_code || null;
    if (!styleCode) { const { data: st } = await admin.from("style_master").select("style_code").eq("id", styleId).maybeSingle(); styleCode = st?.style_code || null; }
    resolvedOutputs = [];
    for (const o of body.outputs) {
      const q = Number(o?.qty);
      if (!Number.isFinite(q) || q <= 0) continue;
      const size = o?.size != null ? String(o.size).trim() : "";
      if (!size) return res.status(400).json({ error: "Each output row needs a size." });
      const color = o?.color != null && String(o.color).trim() ? String(o.color).trim() : (fin?.color || null);
      let itemId = o?.item_id && UUID_RE.test(String(o.item_id)) ? String(o.item_id) : null;
      if (!itemId) {
        const rr = await resolveOrCreateSku(admin, entity.id, { style_id: styleId, style_code: styleCode, color, size, inseam: o?.inseam || null });
        if (rr?.error || !rr?.id) return res.status(400).json({ error: `Could not resolve a SKU for ${color || ""} ${size}: ${rr?.error || "unknown"}` });
        itemId = rr.id;
      }
      resolvedOutputs.push({ item_id: itemId, color, size, qty: q });
    }
    if (resolvedOutputs.length === 0) return res.status(400).json({ error: "The size matrix had no positive quantities." });
  }

  let completedQty = build.target_qty;
  if (resolvedOutputs) {
    completedQty = resolvedOutputs.reduce((s, o) => s + o.qty, 0);
  } else if (body.completed_qty != null && body.completed_qty !== "") {
    completedQty = Number(body.completed_qty);
    if (!Number.isFinite(completedQty) || completedQty <= 0) return res.status(400).json({ error: "completed_qty must be > 0" });
  }

  const finishedAccount = await resolveFinishedInventoryAccount(admin, entity.id);
  if (!finishedAccount) return res.status(400).json({ error: "Finished-style inventory account (1300/inventory%) not found." });

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "mfg_build_complete",
      entity_id: entity.id,
      created_by_user_id: actorUserId,
      reason: `Build complete ${build.build_number || id}`,
      data: {
        build_order_id: id,
        finished_item_id: build.finished_item_id,
        posting_date: todayISO(),
        wip_account_id: build.wip_account_id,
        finished_inventory_account_id: finishedAccount.id,
        accumulated_cost_cents: accum,
        completed_qty: completedQty,
        location_id: build.location_id || null,
        build_number: build.build_number,
        outputs: resolvedOutputs || undefined,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
  }

  const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
  const unitCost = Math.round(accum / completedQty);
  const { data: updated, error: upErr } = await admin.from("mfg_build_orders")
    .update({ status: "completed", completed_qty: completedQty, complete_je_id: jeId, finished_unit_cost_cents: unitCost, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "issued").select().single();
  if (upErr) return res.status(500).json({ error: `JE posted (id=${jeId}) but failed to stamp build: ${upErr.message}` });

  // Record the per-size outputs (uniform per-unit cost, matching the layers).
  // Best-effort: the GL/layers are already posted, so a write failure here is
  // surfaced but not fatal.
  let outputWriteError = null;
  if (resolvedOutputs) {
    await admin.from("mfg_build_outputs").delete().eq("build_order_id", id);
    const rows = resolvedOutputs.map((o) => ({
      build_order_id: id, item_id: o.item_id, color: o.color, size: o.size, qty: o.qty, unit_cost_cents: unitCost,
    }));
    const { error: outErr } = await admin.from("mfg_build_outputs").insert(rows);
    if (outErr) outputWriteError = outErr.message;
  }

  return res.status(200).json({
    output_write_error: outputWriteError,
    ...updated,
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
    inventory_layer_ids: postResult.inventory_layer_ids || null,
    inventory_layer_errors: postResult.inventory_layer_errors || null,
  });
}
