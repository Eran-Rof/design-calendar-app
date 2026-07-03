// api/internal/build-orders/[id]/issue
//
// POST — issue the snapshotted PART + FINISHED-STYLE components into WIP at
//        actual FIFO cost (mfg_build_issue). Moves released → issued and
//        accumulates their COGS into the build's WIP balance. Service
//        components are NOT issued here (capitalized via /service).

import { postEvent } from "../../../_lib/accounting/posting/index.js";
import { UUID_RE, corsHeaders, client, resolveDefaultEntityId, accountByCode, resolveFinishedInventoryAccount, todayISO } from "./_shared.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const actorUserId = body?.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status !== "released") return res.status(409).json({ error: `Build is '${build.status}', not released — issue only from released.` });
  if (!build.wip_account_id) return res.status(400).json({ error: "Build has no WIP account; recreate it after applying the M4 GL migration." });

  const { data: comps } = await admin.from("mfg_build_components").select("*").eq("build_order_id", id);
  const consumable = (comps || []).filter((c) => c.component_kind === "part" || c.component_kind === "finished_style");

  // No part/style components → nothing to draw; just advance status.
  if (consumable.length === 0) {
    const { data: updated } = await admin.from("mfg_build_orders").update({ status: "issued", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "released").select().single();
    return res.status(200).json({ ...updated, note: "No part/style components to issue (services only)." });
  }

  const partsAccount = await accountByCode(admin, entity.id, "1360");
  if (!partsAccount && consumable.some((c) => c.component_kind === "part")) {
    return res.status(400).json({ error: "Inventory-Parts account (1360) not found. Apply the M2 GL migration." });
  }
  const styleAccount = await resolveFinishedInventoryAccount(admin, entity.id);
  if (!styleAccount && consumable.some((c) => c.component_kind === "finished_style")) {
    return res.status(400).json({ error: "Finished-style inventory account (1300/inventory%) not found." });
  }

  const components = consumable.map((c) => c.component_kind === "part"
    ? { component_kind: "part", part_id: c.part_id, qty: c.qty_required, inventory_account_id: partsAccount.id, location_id: build.location_id || null, _cid: c.id }
    : { component_kind: "finished_style", item_id: c.component_item_id, qty: c.qty_required, inventory_account_id: styleAccount.id, _cid: c.id });

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "mfg_build_issue",
      entity_id: entity.id,
      created_by_user_id: actorUserId,
      reason: `Manufacturing build issue ${build.build_number || id}`,
      data: {
        build_order_id: id,
        build_number: build.build_number,
        posting_date: todayISO(),
        wip_account_id: build.wip_account_id,
        components: components.map(({ _cid, ...rest }) => rest), // eslint-disable-line no-unused-vars
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
  }

  // Write back per-component actual cost from the consume results. The drains
  // return one result PER component in declared order (parts in component order,
  // styles in component order — postEvent keeps zero-cogs entries in these
  // arrays, only dropping their JE lines), so align POSITIONALLY. Keying by
  // part_id / component_item_id (as before) collapsed a BOM that legitimately
  // lists the same part/style on more than one line, which both mis-stamped the
  // per-line cost AND made accumulated_cost_cents diverge from the GL WIP debit
  // (so WIP would not net to zero on completion).
  const partResults = postResult.part_consume_results || [];
  const styleResults = postResult.consume_results || [];
  let pi = 0, si = 0, total = 0;
  for (const c of consumable) {
    const cost = c.component_kind === "part"
      ? Number(partResults[pi++]?.cogs_cents || 0)
      : Number(styleResults[si++]?.cogs_cents || 0);
    total += cost;
    await admin.from("mfg_build_components").update({ actual_cost_cents: cost, qty_consumed: c.qty_required }).eq("id", c.id);
  }

  const newAccum = Number(build.accumulated_cost_cents || 0) + total;
  const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
  const { data: updated, error: upErr } = await admin.from("mfg_build_orders")
    .update({ status: "issued", issue_je_id: jeId, accumulated_cost_cents: newAccum, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "released").select().single();
  if (upErr) return res.status(500).json({ error: `JE posted (id=${jeId}) but failed to stamp build: ${upErr.message}` });

  return res.status(200).json({
    ...updated,
    issued_cost_cents: total,
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
  });
}
