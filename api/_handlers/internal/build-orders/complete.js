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

  let completedQty = build.target_qty;
  if (body.completed_qty != null && body.completed_qty !== "") {
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

  return res.status(200).json({
    ...updated,
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
    inventory_layer_ids: postResult.inventory_layer_ids || null,
    inventory_layer_errors: postResult.inventory_layer_errors || null,
  });
}
