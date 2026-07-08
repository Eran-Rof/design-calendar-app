// api/internal/procurement/receipts/:id/post
//
// P13 / C1 — post a draft goods-receipt:
//   1. Allocate capitalized landed-cost rollups across accepted lines by
//      accepted-extended-value → per-line landed_unit_cost_cents.
//   2. Create one FIFO inventory_layers row per accepted line at landed unit
//      cost (source_kind='po_receipt'); stamp inventory_layer_id + landed cost.
//   3. Create the rollup AP invoices as DRAFTS held for bookkeeper approval
//      (status='pending_bookkeeper_approval', gl_status='unposted',
//      is_receipt_rollup=true) + one line each. Capitalized rollups clear the
//      Accrued Landed account (2150); non-capitalized stay on their expense GL.
//   4. Consume po_commitments for the PO.
//   5. Post the goods-receipt GRNI journal entry (P13 GL-C1):
//        DR Inventory (1300) = landed total (matches the FIFO layers)
//        CR GR/IR-goods (2050) = vendor PO goods cost  → cleared by the vendor AP invoice
//        CR Accrued Landed (2150) = capitalized rollups → cleared by the rollup AP invoices
//      Stamp tanda_po_receipts.je_id; flip status='posted'.
//
// Goods are booked into inventory ONCE here. The matched vendor AP invoice
// (3-way match) and the rollup AP invoices clear the GR/IR + Accrued-Landed
// liabilities — they do NOT re-debit inventory or create a second layer, so
// there is no double count. No live data today (native purchase_orders = 0 rows).

import { createClient } from "@supabase/supabase-js";
import { createLayer } from "../../../../_lib/inventory/fifo.js";
import { createPartLayer } from "../../../../_lib/inventory/partFifo.js";
import { postEvent } from "../../../../_lib/accounting/posting/index.js";
// Reuse the SAME inventory-account resolver the adjustments + AP-invoice flows
// use, so the receipt JE debits the same asset account (1300 is a non-postable
// brand-rollup parent; this resolves to the postable on-hand account, e.g. 1310).
import { resolveInventoryAccount } from "../../inventory-adjustments/post.js";

// decimal-string for cents (bigint/number).
function centsToStr(cents) {
  const n = BigInt(Math.trunc(Number(cents)));
  const neg = n < 0n; const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

// Resolve a postable GL account by code for the entity (e.g. 2050/2150).
async function findPostableAccount(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts")
    .select("id, code, is_postable, status")
    .eq("entity_id", entityId).eq("code", code).maybeSingle();
  if (data && data.is_postable && data.status === "active") return data.id;
  return null;
}

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// M5 — complete a manufacturing build from its conversion-PO receipt. Moves the
// build's accumulated WIP into the finished style's inventory at actual cost.
async function completeBuildFromReceipt(admin, res, { receiptId, rcpt, lines, buildOrderId }) {
  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", buildOrderId).maybeSingle();
  if (!build) return res.status(404).json({ error: "Linked build order not found" });
  if (build.status === "completed") return res.status(409).json({ error: "Build already completed" });
  if (build.status !== "issued") {
    return res.status(409).json({ error: `Build ${build.build_number} is '${build.status}' — issue components (and capitalize services) before receiving the finished good.` });
  }

  const capMode = build.conversion_po_mode === "capitalize";

  // Completed qty = accepted qty on the receipt (the finished good), else target.
  const completedQty = (lines || []).reduce((s, l) => s + Number(l.qty_accepted || 0), 0) || Number(build.target_qty);
  if (completedQty <= 0) return res.status(409).json({ error: "Receipt has no accepted quantity." });

  // Procurement mode: every service charge must have been capitalized manually so
  // WIP is complete before receiving. Capitalize (subcontract) mode instead
  // ACCRUES the contractor CMT into WIP right here from the conversion PO — the
  // manual per-service capitalization is disabled for that mode, so skip the gate.
  if (!capMode) {
    const { data: comps } = await admin.from("mfg_build_components").select("component_kind, service_capitalized").eq("build_order_id", buildOrderId);
    const uncap = (comps || []).filter((c) => c.component_kind === "service" && !c.service_capitalized);
    if (uncap.length > 0) return res.status(409).json({ error: `Capitalize all ${uncap.length} service charge(s) on build ${build.build_number} before receiving.` });
  }

  let accum = Number(build.accumulated_cost_cents || 0);

  // ── Capitalize mode: accrue the contractor CMT into WIP (DR 1205 WIP / CR 2160
  //    Accrued CMT) once, at finished-goods receipt. CMT = Σ(accepted qty ×
  //    conversion-PO unit cost). Idempotent on the build's cmt_accrual_je_id so a
  //    retried completion never double-accrues. The vendor CMT bill later clears
  //    2160 (3-way match, POST /build-orders/:id/cmt-invoice). ────────────────
  if (capMode && !build.cmt_accrual_je_id) {
    const { data: poLines } = await admin.from("purchase_order_lines")
      .select("id, unit_cost_cents").eq("purchase_order_id", rcpt.purchase_order_id);
    const costByPol = new Map((poLines || []).map((p) => [p.id, Number(p.unit_cost_cents || 0)]));
    const cmtCents = Math.round((lines || []).reduce(
      (s, l) => s + Number(l.qty_accepted || 0) * (costByPol.get(l.purchase_order_line_id) || 0), 0));
    if (cmtCents > 0) {
      const accruedCmtAcct = await findPostableAccount(admin, rcpt.entity_id, "2160");
      if (!accruedCmtAcct) return res.status(409).json({ error: "No postable Accrued CMT account (gl_accounts code 2160) — apply the 20260951000000 migration." });
      let accrRes;
      try {
        accrRes = await postEvent(admin, {
          kind: "mfg_cmt_accrued",
          entity_id: rcpt.entity_id,
          created_by_user_id: null,
          reason: `Accrue conversion CMT ${build.build_number} (PO receipt)`,
          data: {
            build_order_id: buildOrderId,
            posting_date: rcpt.receipt_date || new Date().toISOString().slice(0, 10),
            wip_account_id: build.wip_account_id,
            accrued_cmt_account_id: accruedCmtAcct,
            cmt_cents: cmtCents,
            build_number: build.build_number,
          },
        });
      } catch (e) {
        return res.status(400).json({ error: `CMT accrual failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      const cmtJeId = accrRes.accrual_je_id || accrRes.cash_je_id || null;
      accum += cmtCents;
      await admin.from("mfg_build_orders").update({
        accumulated_cost_cents: accum, cmt_accrued_cents: cmtCents, cmt_accrual_je_id: cmtJeId,
        updated_at: new Date().toISOString(),
      }).eq("id", buildOrderId);
    }
  }

  if (accum <= 0) return res.status(409).json({ error: "Build WIP cost is 0 — nothing to receive into finished goods." });

  const finishedAcct = (await resolveInventoryAccount(admin, rcpt.entity_id, null))?.id || null;
  if (!finishedAcct) return res.status(409).json({ error: "No postable Inventory asset account for the finished style." });

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "mfg_build_complete",
      entity_id: rcpt.entity_id,
      created_by_user_id: null,
      reason: `Build complete ${build.build_number} (PO receipt)`,
      data: {
        build_order_id: buildOrderId,
        finished_item_id: build.finished_item_id,
        posting_date: rcpt.receipt_date || new Date().toISOString().slice(0, 10),
        wip_account_id: build.wip_account_id,
        finished_inventory_account_id: finishedAcct,
        accumulated_cost_cents: accum,
        completed_qty: completedQty,
        location_id: build.location_id || null,
        build_number: build.build_number,
      },
    });
  } catch (e) {
    return res.status(400).json({ error: `Build completion failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
  const layerId = (postResult.inventory_layer_ids || [])[0] || null;
  if (layerId) {
    for (const l of lines || []) await admin.from("tanda_po_receipt_lines").update({ inventory_layer_id: layerId }).eq("id", l.id);
  }
  await admin.from("tanda_po_receipts").update({ status: "posted", je_id: jeId, build_order_id: buildOrderId }).eq("id", receiptId);

  const unitCost = Math.round(accum / completedQty);
  await admin.from("mfg_build_orders").update({
    status: "completed", completed_qty: completedQty, complete_je_id: jeId,
    finished_unit_cost_cents: unitCost, updated_at: new Date().toISOString(),
  }).eq("id", buildOrderId).eq("status", "issued");

  return res.status(200).json({
    receipt_id: receiptId, status: "posted", build_order_id: buildOrderId, build_completed: true,
    finished_unit_cost_cents: unitCost, completed_qty: completedQty, je_id: jeId,
    inventory_layer_ids: postResult.inventory_layer_ids || null,
    message: `Conversion PO received — build ${build.build_number} completed. ${completedQty} finished unit(s) into inventory at $${(unitCost / 100).toFixed(2)}/unit.`,
  });
}

// Manufacturing parts (P1) — receive a 'manufacturing_part' PO into part
// inventory. Each accepted line stocks its part_id into part_inventory_layers
// (source_kind='po_receipt') and the GRNI JE books DR 1207 Inventory-Parts
// (subledger=part) / CR 2050 GR/IR. The vendor bill later clears 2050 (3-way
// match — POST /purchase-orders/:id/part-bill).
async function receivePartLines(admin, res, { receiptId, rcpt, lines, partByPol, vendorId }) {
  if (!vendorId) return res.status(409).json({ error: "Parent PO has no vendor — cannot post the part receipt GRNI JE." });
  const partsAcctId = await findPostableAccount(admin, rcpt.entity_id, "1207");
  const grirAcctId = await findPostableAccount(admin, rcpt.entity_id, "2050");
  if (!partsAcctId) return res.status(409).json({ error: "No postable Inventory-Parts account (gl_accounts code 1207)." });
  if (!grirAcctId) return res.status(409).json({ error: "No postable GR/IR Clearing account (gl_accounts code 2050) — apply the 20260717120000 migration." });

  const { data: locs } = await admin.from("inventory_locations")
    .select("id, name, kind, is_active").eq("entity_id", rcpt.entity_id).eq("is_active", true);
  const locList = locs || [];
  const loc = locList.find((l) => /warehouse|main|own/i.test(`${l.kind || ""} ${l.name || ""}`)) || locList[0];
  const locationId = loc?.id || null; // part_inventory_layers.location_id is nullable

  // One part FIFO layer per accepted line; accumulate the goods cost per part.
  const layerResults = [];
  const goodsByPart = new Map(); // part_id → cents
  let goodsTotalCents = 0;
  for (const l of lines) {
    const qty = Number(l.qty_accepted || 0);
    const partId = partByPol.get(l.purchase_order_line_id);
    if (qty <= 0 || !partId) continue;
    const unit = Math.round(Number(l.unit_cost_cents || 0));
    try {
      const { layer } = await createPartLayer(admin, {
        entity_id: rcpt.entity_id, part_id: partId, qty, unit_cost_cents: unit,
        source_kind: "po_receipt", location_id: locationId,
        received_at: rcpt.receipt_date ? `${rcpt.receipt_date}T00:00:00Z` : undefined,
        notes: `PO part receipt ${receiptId}`,
      });
      await admin.from("tanda_po_receipt_lines").update({ inventory_layer_id: layer.id, landed_unit_cost_cents: unit }).eq("id", l.id);
      const lineCents = unit * qty;
      goodsByPart.set(partId, (goodsByPart.get(partId) || 0) + lineCents);
      goodsTotalCents += lineCents;
      layerResults.push({ line_id: l.id, layer_id: layer.id, part_id: partId, qty, unit_cost_cents: unit });
    } catch (e) {
      return res.status(500).json({ error: `Part layer creation failed for line ${l.id}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (goodsTotalCents <= 0) return res.status(409).json({ error: "Receipt has no accepted part quantity/cost to stock." });

  let jeId = null;
  try {
    const result = await postEvent(admin, {
      kind: "part_inventory_receipt", entity_id: rcpt.entity_id, created_by_user_id: null,
      reason: `Part goods receipt (GRNI) ${receiptId}`,
      data: {
        receipt_id: receiptId, vendor_id: vendorId, receipt_date: rcpt.receipt_date,
        part_inventory_account_id: partsAcctId, gr_ir_account_id: grirAcctId,
        lines: [...goodsByPart.entries()].map(([part_id, c]) => ({ part_id, amount: centsToStr(c) })),
        goods_amount: centsToStr(goodsTotalCents),
      },
    });
    jeId = result.accrual_je_id;
  } catch (e) {
    return res.status(500).json({ error: `Part receipt GRNI JE failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  await admin.from("tanda_po_receipts").update({ status: "posted", je_id: jeId }).eq("id", receiptId);

  // Roll receipt qty onto the PO lines + recompute header status (mirrors the
  // style path so a part PO reaches 'received'/'in_transit' the same way).
  if (rcpt.purchase_order_id) {
    const { data: poLines } = await admin.from("purchase_order_lines")
      .select("id, qty_ordered, qty_received, status").eq("purchase_order_id", rcpt.purchase_order_id);
    const recvByLine = new Map();
    for (const l of lines) recvByLine.set(l.purchase_order_line_id, (recvByLine.get(l.purchase_order_line_id) || 0) + Number(l.qty_received || 0));
    for (const pl of poLines || []) {
      const add = recvByLine.get(pl.id) || 0;
      if (add <= 0) continue;
      const newRecv = Number(pl.qty_received || 0) + add;
      const fully = newRecv >= Number(pl.qty_ordered || 0);
      await admin.from("purchase_order_lines")
        .update({ qty_received: newRecv, ...(fully && pl.status !== "cancelled" ? { status: "received" } : {}) }).eq("id", pl.id);
    }
    const { data: after } = await admin.from("purchase_order_lines")
      .select("qty_ordered, qty_received, status").eq("purchase_order_id", rcpt.purchase_order_id);
    const active = (after || []).filter((l) => l.status !== "cancelled");
    const allRecv = active.length > 0 && active.every((l) => Number(l.qty_received || 0) >= Number(l.qty_ordered || 0));
    const anyRecv = active.some((l) => Number(l.qty_received || 0) > 0);
    const newStatus = allRecv ? "received" : (anyRecv ? "in_transit" : null);
    if (newStatus) await admin.from("purchase_orders").update({ status: newStatus }).eq("id", rcpt.purchase_order_id).neq("status", "cancelled");
  }

  return res.status(200).json({
    receipt_id: receiptId, status: "posted", part_receipt: true,
    part_layers_created: layerResults.length, je_id: jeId, goods_cost_cents: goodsTotalCents,
    message: `Part receipt posted — ${layerResults.length} part layer(s) stocked into inventory (DR 1207 / CR 2050), GRNI JE posted.`,
    layers: layerResults,
  });
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // ── Load receipt + lines + rollups + parent PO ──────────────────────────────
  const { data: rcpt, error: rErr } = await admin.from("tanda_po_receipts").select("*").eq("id", id).maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!rcpt) return res.status(404).json({ error: "Receipt not found" });
  if (rcpt.status !== "draft") return res.status(409).json({ error: `Only a draft receipt can be posted (status is ${rcpt.status}).` });
  if (!rcpt.purchase_order_id) return res.status(409).json({ error: "C1 posts native-PO receipts only (purchase_order_id required)." });

  const { data: lines } = await admin.from("tanda_po_receipt_lines").select("*").eq("receipt_id", id);
  const { data: rollups } = await admin.from("tanda_po_receipt_rollups").select("*").eq("receipt_id", id);
  if (!lines || lines.length === 0) return res.status(409).json({ error: "Receipt has no lines." });

  // PO line item ids (the SKU or PART each receipt line stocks).
  const polIds = [...new Set(lines.map((l) => l.purchase_order_line_id).filter(Boolean))];
  const { data: polRows } = await admin.from("purchase_order_lines").select("id, inventory_item_id, part_id, lot_number").in("id", polIds);
  const itemByPol = new Map((polRows || []).map((p) => [p.id, p.inventory_item_id]));
  const partByPol = new Map((polRows || []).map((p) => [p.id, p.part_id || null]));
  // Carry the PO line's lot onto the receipt's inventory layer so on-hand stock
  // is lot-identified for lot-aware allocation (Scenario 5).
  const lotByPol = new Map((polRows || []).map((p) => [p.id, p.lot_number || null]));

  const { data: po } = await admin.from("purchase_orders").select("id, vendor_id, po_type").eq("id", rcpt.purchase_order_id).maybeSingle();
  const vendorId = po?.vendor_id || null;

  // ── Manufacturing (M5): a conversion-PO receipt COMPLETES a build ───────────
  // If this receipt (or its PO) is tied to a build order, receiving the finished
  // good moves the build's accumulated WIP into finished-goods inventory at the
  // real build cost (mfg_build_complete) instead of the normal goods-receipt
  // path — no GRNI / landed-cost layer at the PO line's nominal unit cost.
  let buildOrderId = rcpt.build_order_id || null;
  if (!buildOrderId && rcpt.purchase_order_id) {
    const { data: bo } = await admin.from("mfg_build_orders").select("id").eq("conversion_po_id", rcpt.purchase_order_id).maybeSingle();
    buildOrderId = bo?.id || null;
  }
  if (buildOrderId) {
    return completeBuildFromReceipt(admin, res, { receiptId: id, rcpt, lines, buildOrderId });
  }

  // ── Manufacturing parts: a 'manufacturing_part' PO stocks PART inventory ─────
  // (part_inventory_layers / 1207) rather than style inventory. Any line with a
  // part_id routes here; a manufacturing_part PO carries only part lines.
  const isPartReceipt = po?.po_type === "manufacturing_part" || (polRows || []).some((p) => p.part_id);
  if (isPartReceipt) {
    return receivePartLines(admin, res, { receiptId: id, rcpt, lines, partByPol, vendorId });
  }

  // GL accounts for the goods-receipt GRNI JE (step 5).
  const inventoryAcctId = (await resolveInventoryAccount(admin, rcpt.entity_id, null))?.id || null;
  const grirAcctId = await findPostableAccount(admin, rcpt.entity_id, "2050");
  const accruedLandedAcctId = await findPostableAccount(admin, rcpt.entity_id, "2150");
  if (!inventoryAcctId) return res.status(409).json({ error: "No postable Inventory asset account (gl_accounts code 1300/1310 or name ILIKE 'inventory%') — cannot post the receipt JE." });
  if (!grirAcctId) return res.status(409).json({ error: "No postable GR/IR Clearing account (gl_accounts code 2050) — apply the 20260717120000 migration." });
  if (!vendorId) return res.status(409).json({ error: "Parent PO has no vendor — cannot post the receipt GRNI JE." });

  // Receiving location (inventory_layers.location_id is NOT NULL). Prefer a
  // warehouse / "Main" location for the entity; fall back to the first active.
  const { data: locs } = await admin.from("inventory_locations")
    .select("id, name, kind, is_active").eq("entity_id", rcpt.entity_id).eq("is_active", true);
  const locList = locs || [];
  const loc =
    locList.find((l) => /warehouse|main|own/i.test(`${l.kind || ""} ${l.name || ""}`)) ||
    locList[0];
  if (!loc) return res.status(409).json({ error: "No active inventory location for this entity — create one before receiving." });
  const locationId = loc.id;

  // ── 1. Landed-cost allocation (capitalized rollups, value-weighted) ─────────
  const capTotal = (rollups || []).filter((r) => r.capitalized_to_inventory !== false)
    .reduce((s, r) => s + Number(r.amount_cents || 0), 0);
  const extOf = (l) => Number(l.qty_accepted || 0) * Number(l.unit_cost_cents || 0);
  const receiptExt = lines.reduce((s, l) => s + extOf(l), 0);

  // ── 2. Create a FIFO layer per accepted line at landed unit cost ────────────
  //    Accumulate the per-item landed total (in cents) so the GRNI JE (step 5)
  //    debits inventory at EXACTLY what the layers hold (no rounding drift).
  const layerResults = [];
  const landedByItem = new Map(); // item_id → landed cents (Σ landedUnit × qty)
  let landedTotalCents = 0;
  for (const l of lines) {
    const qty = Number(l.qty_accepted || 0);
    const itemId = itemByPol.get(l.purchase_order_line_id);
    if (qty <= 0 || !itemId) continue;
    const allocCents = (capTotal > 0 && receiptExt > 0) ? Math.round(capTotal * (extOf(l) / receiptExt)) : 0;
    const landedUnit = Math.round(Number(l.unit_cost_cents || 0) + (qty > 0 ? allocCents / qty : 0));
    try {
      const { layer } = await createLayer(admin, {
        entity_id: rcpt.entity_id, item_id: itemId, qty,
        unit_cost_cents: landedUnit, source_kind: "po_receipt", location_id: locationId,
        received_at: rcpt.receipt_date ? `${rcpt.receipt_date}T00:00:00Z` : undefined,
        lot_number: lotByPol.get(l.purchase_order_line_id) || null,
        notes: `PO receipt ${id}`,
      });
      await admin.from("tanda_po_receipt_lines")
        .update({ inventory_layer_id: layer.id, landed_unit_cost_cents: landedUnit })
        .eq("id", l.id);
      const lineLanded = landedUnit * qty;
      landedByItem.set(itemId, (landedByItem.get(itemId) || 0) + lineLanded);
      landedTotalCents += lineLanded;
      layerResults.push({ line_id: l.id, layer_id: layer.id, qty, landed_unit_cost_cents: landedUnit });
    } catch (e) {
      return res.status(500).json({ error: `Layer creation failed for line ${l.id}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ── 3. Rollup AP invoices → bookkeeper approval queue (drafts, unposted) ────
  const rollupInvoices = [];
  for (let i = 0; i < (rollups || []).length; i++) {
    const r = rollups[i];
    const vendorId = r.vendor_id || po?.vendor_id;
    if (!vendorId) { rollupInvoices.push({ rollup_id: r.id, skipped: "no vendor" }); continue; }
    const invNo = `RCPT-${String(id).slice(0, 8)}-${i + 1}`;
    const { data: inv, error: iErr } = await admin.from("invoices").insert({
      entity_id: rcpt.entity_id, vendor_id: vendorId, invoice_number: invNo,
      invoice_kind: "vendor_bill", gl_status: "unposted", status: "pending_bookkeeper_approval",
      posting_date: rcpt.receipt_date, due_date: rcpt.receipt_date,
      description: r.description || "Receipt landed-cost rollup",
      is_receipt_rollup: true, rollup_parent_receipt_id: id, source: "system",
    }).select("id").single();
    if (iErr) { rollupInvoices.push({ rollup_id: r.id, error: iErr.message }); continue; }
    // Capitalized rollups were folded into the layers' landed cost AND credited
    // to Accrued Landed (2150) by the GRNI JE, so this AP invoice must clear
    // 2150 (DR 2150 / CR AP on approval) — NOT re-hit an expense account, which
    // would double-count the freight. Non-capitalized rollups stay on their
    // chosen expense GL (true period cost).
    const capitalized = r.capitalized_to_inventory !== false;
    const lineAcctId = (capitalized && accruedLandedAcctId) ? accruedLandedAcctId : r.expense_gl_account_id;
    const { error: lErr } = await admin.from("invoice_line_items").insert({
      invoice_id: inv.id, entity_id: rcpt.entity_id, line_index: 1,
      description: r.description || (capitalized ? "Landed-cost rollup (clears Accrued Landed)" : "Landed-cost rollup"),
      expense_account_id: lineAcctId, quantity: 1, unit_cost_cents: Number(r.amount_cents) || 0, tax_amount_cents: 0,
    });
    if (lErr) { await admin.from("invoices").delete().eq("id", inv.id); rollupInvoices.push({ rollup_id: r.id, error: lErr.message }); continue; }
    await admin.from("tanda_po_receipt_rollups").update({ auto_invoice_id: inv.id }).eq("id", r.id);
    rollupInvoices.push({ rollup_id: r.id, invoice_id: inv.id, invoice_number: invNo });
  }

  // ── 4. Consume PO commitments (native PO) ───────────────────────────────────
  const receivedValue = lines.reduce((s, l) => s + Number(l.qty_received || 0) * Number(l.unit_cost_cents || 0), 0);
  const { data: commits } = await admin.from("po_commitments")
    .select("id, committed_amount_cents, consumed_amount_cents, status")
    .eq("purchase_order_id", rcpt.purchase_order_id).in("status", ["open", "partial"]);
  // Simple roll-up: apply receivedValue against the PO's open commitments oldest-first.
  let remaining = receivedValue;
  for (const c of commits || []) {
    if (remaining <= 0) break;
    const room = Number(c.committed_amount_cents) - Number(c.consumed_amount_cents);
    const apply = Math.min(room, remaining);
    const newConsumed = Number(c.consumed_amount_cents) + apply;
    const fullyConsumed = newConsumed >= Number(c.committed_amount_cents);
    await admin.from("po_commitments").update({
      consumed_amount_cents: newConsumed,
      status: fullyConsumed ? "closed" : "partial",
      closed_at: fullyConsumed ? new Date().toISOString() : null,
    }).eq("id", c.id);
    remaining -= apply;
  }

  // ── 5. Post the goods-receipt GRNI journal entry ────────────────────────────
  //    DR Inventory (per item, landed)  = landedTotalCents (matches the layers)
  //    CR GR/IR-goods (2050)            = landedTotal − capitalized rollups
  //    CR Accrued Landed (2150)         = capitalized rollups  (when > 0)
  // capTotal is the capitalized rollup cents already folded into the layers;
  // crediting Accrued Landed for it exactly nets the rollup AP invoices to zero.
  let jeId = null;
  if (landedTotalCents > 0) {
    const capCents = Math.min(capTotal, landedTotalCents);     // never exceed DR
    const goodsCents = landedTotalCents - capCents;
    if (capCents > 0 && !accruedLandedAcctId) {
      return res.status(409).json({ error: "Capitalized rollups present but no postable Accrued Landed account (gl_accounts code 2150)." });
    }
    const jeLines = [...landedByItem.entries()]
      .filter(([, c]) => c > 0)
      .map(([item_id, c]) => ({ item_id, amount: centsToStr(c) }));
    try {
      const result = await postEvent(admin, {
        kind: "inventory_receipt",
        entity_id: rcpt.entity_id,
        created_by_user_id: null,
        reason: `Goods receipt (GRNI) ${id}`,
        data: {
          receipt_id: id,
          vendor_id: vendorId,
          receipt_date: rcpt.receipt_date,
          inventory_account_id: inventoryAcctId,
          gr_ir_account_id: grirAcctId,
          accrued_landed_account_id: accruedLandedAcctId,
          lines: jeLines,
          goods_amount: centsToStr(goodsCents),
          accrued_landed_amount: centsToStr(capCents),
          source_table: "tanda_po_receipts",
        },
      });
      jeId = result.accrual_je_id;
    } catch (e) {
      return res.status(500).json({ error: `Receipt GRNI JE failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ── 6. Flip the receipt to posted + stamp the JE ────────────────────────────
  await admin.from("tanda_po_receipts").update({ status: "posted", landed_cost_cents: capTotal, je_id: jeId }).eq("id", id);

  // ── 6b. Roll the receipt up onto the native PO so "received" is REAL ─────────
  // Bump each PO line's qty_received (+ flip its line status when fully received)
  // and recompute the PO header status: 'received' when every line is fully in,
  // else 'in_transit' (partial). This is the ONLY path that sets a PO 'received'
  // — the modal's manual flip is blocked — so the status always reflects a posted,
  // GL'd goods receipt.
  if (rcpt.purchase_order_id) {
    const { data: poLines } = await admin.from("purchase_order_lines")
      .select("id, qty_ordered, qty_received, status").eq("purchase_order_id", rcpt.purchase_order_id);
    const recvByLine = new Map();
    for (const l of lines) recvByLine.set(l.purchase_order_line_id, (recvByLine.get(l.purchase_order_line_id) || 0) + Number(l.qty_received || 0));
    for (const pl of poLines || []) {
      const add = recvByLine.get(pl.id) || 0;
      if (add <= 0) continue;
      const newRecv = Number(pl.qty_received || 0) + add;
      const fully = newRecv >= Number(pl.qty_ordered || 0);
      await admin.from("purchase_order_lines")
        .update({ qty_received: newRecv, ...(fully && pl.status !== "cancelled" ? { status: "received" } : {}) })
        .eq("id", pl.id);
    }
    // Recompute header status from the (now-updated) lines.
    const { data: after } = await admin.from("purchase_order_lines")
      .select("qty_ordered, qty_received, status").eq("purchase_order_id", rcpt.purchase_order_id);
    const active = (after || []).filter((l) => l.status !== "cancelled");
    const anyRecv = active.some((l) => Number(l.qty_received || 0) > 0);
    const allRecv = active.length > 0 && active.every((l) => Number(l.qty_received || 0) >= Number(l.qty_ordered || 0));
    const newStatus = allRecv ? "received" : (anyRecv ? "in_transit" : null);
    if (newStatus) {
      await admin.from("purchase_orders").update({ status: newStatus }).eq("id", rcpt.purchase_order_id).neq("status", "cancelled");
    }
  }

  const rollupCount = rollupInvoices.filter((x) => x.invoice_id).length;
  return res.status(200).json({
    receipt_id: id, status: "posted",
    layers_created: layerResults.length, landed_cost_cents: capTotal,
    je_id: jeId,
    rollup_invoices_queued: rollupCount,
    message: `Receipt posted — ${layerResults.length} inventory layer(s) created${jeId ? ", GRNI JE posted" : ""}${rollupCount ? `, ${rollupCount} rollup AP invoice(s) sent to bookkeeper approval` : ""}.`,
    layers: layerResults, rollup_invoices: rollupInvoices,
  });
}
