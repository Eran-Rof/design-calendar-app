// api/internal/procurement/receipts/:id/post
//
// P13 / C1 — post a draft goods-receipt:
//   1. Allocate capitalized landed-cost rollups across accepted lines by
//      accepted-extended-value → per-line landed_unit_cost_cents.
//   2. Create one FIFO inventory_layers row per accepted line at landed unit
//      cost (source_kind='po_receipt'); stamp inventory_layer_id + landed cost.
//   3. Create the rollup AP invoices as DRAFTS held for bookkeeper approval
//      (status='pending_bookkeeper_approval', gl_status='unposted',
//      is_receipt_rollup=true) + one expense line each.
//   4. Consume po_commitments for the PO.
//   5. receipt.status='posted'.
//
// SCOPE NOTE (C1): this does NOT post an inventory-receipt JE (GRNI). The rollup
// AP invoices post to the GL only after a bookkeeper approves them via the normal
// AP flow. Ensuring a later matched vendor AP invoice does NOT create a second
// layer for the same goods is handled in C4 (3-way match). No live double-count
// today (native purchase_orders has 0 rows).

import { createClient } from "@supabase/supabase-js";
import { createLayer } from "../../../../_lib/inventory/fifo.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // PO line item ids (the SKU each receipt line stocks).
  const polIds = [...new Set(lines.map((l) => l.purchase_order_line_id).filter(Boolean))];
  const { data: polRows } = await admin.from("purchase_order_lines").select("id, inventory_item_id").in("id", polIds);
  const itemByPol = new Map((polRows || []).map((p) => [p.id, p.inventory_item_id]));

  const { data: po } = await admin.from("purchase_orders").select("id, vendor_id").eq("id", rcpt.purchase_order_id).maybeSingle();

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
  const layerResults = [];
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
        notes: `PO receipt ${id}`,
      });
      await admin.from("tanda_po_receipt_lines")
        .update({ inventory_layer_id: layer.id, landed_unit_cost_cents: landedUnit })
        .eq("id", l.id);
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
    const { error: lErr } = await admin.from("invoice_line_items").insert({
      invoice_id: inv.id, entity_id: rcpt.entity_id, line_index: 1, description: r.description || "Landed-cost rollup",
      expense_account_id: r.expense_gl_account_id, quantity: 1, unit_cost_cents: Number(r.amount_cents) || 0, tax_amount_cents: 0,
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

  // ── 5. Post the receipt ─────────────────────────────────────────────────────
  await admin.from("tanda_po_receipts").update({ status: "posted", landed_cost_cents: capTotal }).eq("id", id);

  const rollupCount = rollupInvoices.filter((x) => x.invoice_id).length;
  return res.status(200).json({
    receipt_id: id, status: "posted",
    layers_created: layerResults.length, landed_cost_cents: capTotal,
    rollup_invoices_queued: rollupCount,
    message: `Receipt posted — ${layerResults.length} inventory layer(s) created${rollupCount ? `, ${rollupCount} rollup AP invoice(s) sent to bookkeeper approval` : ""}.`,
    layers: layerResults, rollup_invoices: rollupInvoices,
  });
}
