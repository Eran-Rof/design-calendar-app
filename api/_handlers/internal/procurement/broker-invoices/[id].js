// api/internal/procurement/broker-invoices/:id  (h595)
//
// P13-C3 — Trade Compliance vertical, single broker-invoice CRUD (data-only).
//
// GET    → header + embedded vendor name + linked customs entry_number.
// PATCH  → edit any field. When charge components are touched, total_cents is
//          re-validated/recomputed (>= the component sum, or computed from them).
// DELETE → removes the broker invoice.
//
// FINANCIALLY INERT: no AP invoice creation (ap_invoice_id stays NULL), no
// allocation JE (allocation_je_id stays NULL). Landed-cost allocation onto FIFO
// layers is owned by a separate chunk.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../../_lib/accounting/posting/index.js";
import { resolveInventoryAccount } from "../../inventory-adjustments/post.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOCATION_METHODS = ["value", "weight", "cbm", "manual"];

function centsToStr(cents) {
  const n = BigInt(Math.trunc(Number(cents)));
  const neg = n < 0n; const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
async function findPostableAccount(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts")
    .select("id, is_postable, status").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return (data && data.is_postable && data.status === "active") ? data.id : null;
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

function optCents(val, label) {
  if (val == null || val === "") return { v: 0 };
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer (cents)` };
  return { v: n };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: inv, error: iErr } = await admin
    .from("broker_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (iErr) return res.status(500).json({ error: iErr.message });
  if (!inv) return res.status(404).json({ error: "Broker invoice not found" });

  if (req.method === "GET") {
    let vendor_name = null, customs_entry_number = null;
    if (inv.vendor_id) {
      const { data: v } = await admin.from("vendors").select("name").eq("id", inv.vendor_id).maybeSingle();
      vendor_name = v ? v.name : null;
    }
    if (inv.customs_entry_id) {
      const { data: ce } = await admin.from("customs_entries").select("entry_number").eq("id", inv.customs_entry_id).maybeSingle();
      customs_entry_number = ce ? ce.entry_number : null;
    }
    return res.status(200).json({ ...inv, vendor_name, customs_entry_number });
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("broker_invoices").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    // ── action: post — allocate this broker bill onto a native receipt's FIFO
    //    layers + post the landed-cost revaluation JE (P13 GL-C4). ───────────
    if (body.action === "post") {
      if (inv.allocation_je_id) return res.status(409).json({ error: "Broker invoice already posted (allocation JE exists)." });
      const totalCents = Number(inv.total_cents) || 0;
      if (totalCents <= 0) return res.status(409).json({ error: "Broker invoice total is zero — nothing to allocate." });
      if (!inv.vendor_id) return res.status(409).json({ error: "Broker invoice has no vendor (the broker) — cannot post AP." });

      const receiptId = (inv.tanda_po_receipt_id && UUID_RE.test(String(inv.tanda_po_receipt_id))) ? inv.tanda_po_receipt_id
        : (body.tanda_po_receipt_id && UUID_RE.test(String(body.tanda_po_receipt_id))) ? body.tanda_po_receipt_id : null;
      if (!receiptId) return res.status(400).json({ error: "tanda_po_receipt_id required — the posted native receipt to allocate landed cost onto." });

      const { data: rcpt } = await admin.from("tanda_po_receipts").select("id, status, entity_id").eq("id", receiptId).maybeSingle();
      if (!rcpt || rcpt.entity_id !== inv.entity_id) return res.status(404).json({ error: "Receipt not found for this entity." });
      if (rcpt.status !== "posted") return res.status(409).json({ error: "Receipt must be posted before landed costs can be allocated." });

      // Receipt lines with their FIFO layer (carries original/remaining qty + cost).
      const { data: rlines } = await admin.from("tanda_po_receipt_lines")
        .select("id, inventory_layer_id, qty_accepted, unit_cost_cents, purchase_order_line_id").eq("receipt_id", receiptId);
      const layerIds = (rlines || []).map((l) => l.inventory_layer_id).filter(Boolean);
      if (layerIds.length === 0) return res.status(409).json({ error: "Receipt has no inventory layers to revalue." });
      const { data: layers } = await admin.from("inventory_layers")
        .select("id, item_id, original_qty, remaining_qty, unit_cost_cents").in("id", layerIds);
      const layerById = new Map((layers || []).map((l) => [l.id, l]));
      const { data: polRows } = await admin.from("purchase_order_lines")
        .select("id, inventory_item_id").in("id", [...new Set((rlines || []).map((l) => l.purchase_order_line_id).filter(Boolean))]);
      const itemByPol = new Map((polRows || []).map((p) => [p.id, p.inventory_item_id]));

      // Allocate the broker total across lines by value (qty_accepted × unit cost).
      // weight / cbm methods fall back to value until per-line weight/cbm is captured.
      const targets = (rlines || []).filter((l) => l.inventory_layer_id && Number(l.qty_accepted) > 0 && layerById.has(l.inventory_layer_id));
      const valueOf = (l) => Number(l.qty_accepted || 0) * Number(l.unit_cost_cents || 0);
      const totalValue = targets.reduce((s, l) => s + valueOf(l), 0);
      if (totalValue <= 0) return res.status(409).json({ error: "Receipt lines have zero value — cannot allocate by value." });

      // Per-line allocation (largest-remainder so the parts sum to the total).
      let allocated = 0;
      const perLine = targets.map((l, i) => {
        const isLast = i === targets.length - 1;
        const alloc = isLast ? (totalCents - allocated) : Math.round(totalCents * (valueOf(l) / totalValue));
        allocated += isLast ? 0 : alloc;
        return { line: l, alloc };
      });

      // Split each line's allocation into a per-unit uplift (capitalized to the
      // remaining FIFO qty) + a consumed-portion variance (units already sold).
      const upliftByItem = new Map(); // item_id → cents
      const layerBumps = [];          // { layer_id, new_unit_cost_cents }
      let consumedTotal = 0;
      for (const { line, alloc } of perLine) {
        const layer = layerById.get(line.inventory_layer_id);
        const itemId = layer.item_id || itemByPol.get(line.purchase_order_line_id);
        const orig = Number(layer.original_qty) || 0;
        const remaining = Number(layer.remaining_qty) || 0;
        if (orig <= 0) { consumedTotal += alloc; continue; }
        const perUnit = Math.round(alloc / orig);          // integer cents/unit
        const uplift = perUnit * remaining;                 // capitalized to stock
        const consumed = alloc - uplift;                    // expensed (sold units)
        if (uplift > 0 && perUnit > 0) {
          upliftByItem.set(itemId, (upliftByItem.get(itemId) || 0) + uplift);
          layerBumps.push({ layer_id: layer.id, new_unit_cost_cents: Number(layer.unit_cost_cents) + perUnit });
        }
        if (consumed > 0) consumedTotal += consumed;
      }

      const inventoryAcctId = (await resolveInventoryAccount(admin, inv.entity_id, null))?.id || null;
      const varianceAcctId = await findPostableAccount(admin, inv.entity_id, "5150");
      const { data: ent } = await admin.from("entities").select("default_ap_account_id").eq("id", inv.entity_id).maybeSingle();
      const apAccountId = (ent && ent.default_ap_account_id) || (await findPostableAccount(admin, inv.entity_id, "2010"));
      if (!inventoryAcctId || !apAccountId) return res.status(409).json({ error: "Need postable Inventory + AP (2010) accounts to post landed cost." });
      if (consumedTotal > 0 && !varianceAcctId) return res.status(409).json({ error: "Some units already sold but no postable Landed Cost Variance account (5150)." });

      // Create the broker AP invoice (payable record) for the broker vendor.
      const invNo = inv.broker_invoice_number || `BRK-${String(id).slice(0, 8)}`;
      const { data: apInv, error: hErr } = await admin.from("invoices").insert({
        entity_id: inv.entity_id, vendor_id: inv.vendor_id, invoice_number: invNo,
        invoice_kind: "vendor_bill", gl_status: "unposted", posting_date: inv.invoice_date, due_date: inv.invoice_date,
        ap_account_id: apAccountId, source: "system", description: `Broker / customs landed cost ${invNo}`,
      }).select("id").single();
      if (hErr) {
        if (hErr.code === "23505") return res.status(409).json({ error: "An AP invoice with that number already exists for this vendor." });
        return res.status(500).json({ error: hErr.message });
      }
      const { error: lErr } = await admin.from("invoice_line_items").insert({
        invoice_id: apInv.id, entity_id: inv.entity_id, line_index: 1, description: `Landed cost allocation (receipt ${String(receiptId).slice(0, 8)})`,
        expense_account_id: varianceAcctId || inventoryAcctId, quantity: 1, unit_cost_cents: totalCents, tax_amount_cents: 0,
      });
      if (lErr) { await admin.from("invoices").delete().eq("id", apInv.id); return res.status(500).json({ error: `AP invoice line failed: ${lErr.message}` }); }

      // Post the revaluation JE.
      let jeId = null;
      try {
        const result = await postEvent(admin, {
          kind: "landed_cost_revaluation", entity_id: inv.entity_id, created_by_user_id: null,
          reason: `Landed-cost revaluation ${invNo}`,
          data: {
            invoice_id: apInv.id, vendor_id: inv.vendor_id, invoice_number: invNo, invoice_date: inv.invoice_date,
            ap_account_id: apAccountId, inventory_account_id: inventoryAcctId, variance_account_id: varianceAcctId,
            inventory_lines: [...upliftByItem.entries()].filter(([, c]) => c > 0).map(([item_id, c]) => ({ item_id, amount: centsToStr(c) })),
            consumed_variance_amount: centsToStr(consumedTotal),
            total_amount: centsToStr(totalCents),
          },
        });
        jeId = result.accrual_je_id;
      } catch (e) {
        await admin.from("invoices").delete().eq("id", apInv.id);
        return res.status(500).json({ error: `Landed-cost revaluation JE failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      await admin.from("invoices").update({ gl_status: "posted" }).eq("id", apInv.id);

      // Bump the remaining FIFO layers' unit cost (capitalize the in-stock share).
      for (const b of layerBumps) {
        await admin.from("inventory_layers").update({ unit_cost_cents: b.new_unit_cost_cents }).eq("id", b.layer_id);
      }

      // Stamp the broker invoice + (if linked) the customs entry.
      await admin.from("broker_invoices").update({ ap_invoice_id: apInv.id, allocation_je_id: jeId, tanda_po_receipt_id: receiptId }).eq("id", id);
      if (inv.customs_entry_id) await admin.from("customs_entries").update({ revaluation_je_id: jeId }).eq("id", inv.customs_entry_id);

      const { data: fresh } = await admin.from("broker_invoices").select("*").eq("id", id).single();
      return res.status(200).json({
        ...fresh, je_id: jeId, ap_invoice_id: apInv.id,
        layers_revalued: layerBumps.length, consumed_variance_cents: consumedTotal,
        message: `Landed cost posted — ${layerBumps.length} layer(s) revalued, ${consumedTotal > 0 ? `${centsToStr(consumedTotal)} expensed on sold units` : "all units still in stock"}.`,
      });
    }

    const patch = {};
    if ("vendor_id" in body) {
      if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) return res.status(400).json({ error: "vendor_id (uuid) required" });
      patch.vendor_id = body.vendor_id;
    }
    if ("broker_invoice_number" in body) {
      const n = body.broker_invoice_number ? String(body.broker_invoice_number).trim() : "";
      if (!n) return res.status(400).json({ error: "broker_invoice_number cannot be empty" });
      patch.broker_invoice_number = n;
    }
    if ("invoice_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.invoice_date || ""))) {
        return res.status(400).json({ error: "invoice_date must be YYYY-MM-DD" });
      }
      patch.invoice_date = body.invoice_date;
    }
    if ("customs_entry_id" in body) {
      patch.customs_entry_id = body.customs_entry_id && UUID_RE.test(String(body.customs_entry_id)) ? body.customs_entry_id : null;
    }
    if ("allocation_method" in body) {
      const m = body.allocation_method ? String(body.allocation_method).trim() : "value";
      if (!ALLOCATION_METHODS.includes(m)) return res.status(400).json({ error: `allocation_method must be one of ${ALLOCATION_METHODS.join(", ")}` });
      patch.allocation_method = m;
    }

    // Charge components: validate each touched field; recompute total when any
    // component changes (or when total itself is supplied).
    const touchesComponent =
      "freight_cents" in body || "brokerage_fee_cents" in body || "duty_advance_cents" in body || "other_cents" in body;

    const freight = optCents("freight_cents" in body ? body.freight_cents : inv.freight_cents, "freight_cents");
    if (freight.error) return res.status(400).json({ error: freight.error });
    const brokerage = optCents("brokerage_fee_cents" in body ? body.brokerage_fee_cents : inv.brokerage_fee_cents, "brokerage_fee_cents");
    if (brokerage.error) return res.status(400).json({ error: brokerage.error });
    const dutyAdv = optCents("duty_advance_cents" in body ? body.duty_advance_cents : inv.duty_advance_cents, "duty_advance_cents");
    if (dutyAdv.error) return res.status(400).json({ error: dutyAdv.error });
    const other = optCents("other_cents" in body ? body.other_cents : inv.other_cents, "other_cents");
    if (other.error) return res.status(400).json({ error: other.error });

    if ("freight_cents" in body) patch.freight_cents = freight.v;
    if ("brokerage_fee_cents" in body) patch.brokerage_fee_cents = brokerage.v;
    if ("duty_advance_cents" in body) patch.duty_advance_cents = dutyAdv.v;
    if ("other_cents" in body) patch.other_cents = other.v;

    const componentSum = freight.v + brokerage.v + dutyAdv.v + other.v;
    if ("total_cents" in body && body.total_cents != null && body.total_cents !== "") {
      const t = optCents(body.total_cents, "total_cents");
      if (t.error) return res.status(400).json({ error: t.error });
      if (t.v < componentSum) {
        return res.status(400).json({ error: `total_cents (${t.v}) must be >= the sum of freight + brokerage + duty advance + other (${componentSum})` });
      }
      patch.total_cents = t.v;
    } else if (touchesComponent) {
      // Components changed without an explicit total — recompute to the sum.
      patch.total_cents = componentSum;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(inv);

    // Re-validate FK targets when changed.
    if (patch.vendor_id) {
      const { data: ven } = await admin.from("vendors").select("id, entity_id").eq("id", patch.vendor_id).maybeSingle();
      if (!ven || ven.entity_id !== inv.entity_id) return res.status(404).json({ error: "Vendor not found" });
    }
    if (patch.customs_entry_id) {
      const { data: ce } = await admin.from("customs_entries").select("id, entity_id").eq("id", patch.customs_entry_id).maybeSingle();
      if (!ce || ce.entity_id !== inv.entity_id) return res.status(404).json({ error: "Customs entry not found" });
    }

    const { error: uErr } = await admin.from("broker_invoices").update(patch).eq("id", id);
    if (uErr) {
      if (uErr.code === "23505") return res.status(409).json({ error: "Broker invoice number already exists for this vendor." });
      return res.status(500).json({ error: uErr.message });
    }

    const { data: fresh, error: fErr } = await admin.from("broker_invoices").select("*").eq("id", id).single();
    if (fErr) return res.status(500).json({ error: fErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
