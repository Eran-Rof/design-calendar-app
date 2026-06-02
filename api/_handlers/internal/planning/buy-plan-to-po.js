// api/internal/planning/buy-plan-to-po  (h601)
//
// M31 integration (direction A) — turn an approved Inventory-Planning buy plan
// into DRAFT native Tangerine purchase orders, instead of the Xoro writeback /
// xlsx export.
//
// POST { batch_id, dry_run? }  (x-user-email header; permission: run_writeback)
//   • Loads the execution batch + its `create_buy_request` actions.
//   • Per action: qty = approved_qty ?? suggested_qty (>0); SKU = sku_id
//     (ip_item_master.id, which is also purchase_order_lines.inventory_item_id);
//     vendor = ip_vendor_master.portal_vendor_id (→ vendors.id); unit cost =
//     ip_item_master.unit_cost (dollars → cents).
//   • Groups eligible actions by Tangerine vendor → ONE draft PO per vendor with
//     N lines. POs are created `status='draft'` (no po_number, no commitments) —
//     the operator reviews + issues them in the Tangerine Procurement PO panel.
//   • Idempotent: an action already linked to a PO (response_json.tangerine_po_id)
//     is skipped. Actions with no vendor / no portal link / zero qty are skipped
//     with a reason. dry_run previews without writing.
//
// No Xoro involvement; no data plumbing into planning (read-only on ip_* +
// ip_vendor_master/ip_item_master). Mirrors purchase-orders/index.js inserts.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

const READY_BATCH_STATUSES = ["approved", "exported", "submitted", "partially_executed"];

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const perm = await checkPermission(req, "run_writeback");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const batchId = body.batch_id;
  const dryRun = body.dry_run === true || body.dry_run === "1";
  if (!batchId) return res.status(400).json({ error: "batch_id required" });

  // ── Batch + actions ─────────────────────────────────────────────────────
  const { data: batch } = await admin.from("ip_execution_batches").select("id, batch_name, status").eq("id", batchId).maybeSingle();
  if (!batch) return res.status(404).json({ error: "Execution batch not found" });
  if (!READY_BATCH_STATUSES.includes(batch.status)) {
    return res.status(409).json({ error: `Batch must be approved before creating POs (status is ${batch.status}).` });
  }

  const { data: actions } = await admin.from("ip_execution_actions")
    .select("id, action_type, sku_id, vendor_id, period_start, suggested_qty, approved_qty, execution_status, response_json")
    .eq("execution_batch_id", batchId)
    .eq("action_type", "create_buy_request");
  if (!actions || actions.length === 0) return res.status(409).json({ error: "Batch has no create_buy_request actions." });

  // ── Bulk-resolve vendor portal links + item costs ───────────────────────
  const vendorIds = [...new Set(actions.map((a) => a.vendor_id).filter(Boolean))];
  const skuIds = [...new Set(actions.map((a) => a.sku_id).filter(Boolean))];
  const { data: vmRows } = vendorIds.length
    ? await admin.from("ip_vendor_master").select("id, vendor_code, name, portal_vendor_id").in("id", vendorIds) : { data: [] };
  const vmById = new Map((vmRows || []).map((v) => [v.id, v]));
  const { data: imRows } = skuIds.length
    ? await admin.from("ip_item_master").select("id, sku_code, unit_cost").in("id", skuIds) : { data: [] };
  const imById = new Map((imRows || []).map((i) => [i.id, i]));

  const skipped = [];
  const warnings = [];
  const byVendor = new Map(); // portal vendor_id → { vendor_name, lines:[{action_id, inventory_item_id, qty, unit_cost_cents, ...}], period_starts:[] }

  for (const a of actions) {
    if (a.response_json && a.response_json.tangerine_po_id) { skipped.push({ action_id: a.id, reason: "already linked to a Tangerine PO" }); continue; }
    if (a.execution_status === "cancelled") { skipped.push({ action_id: a.id, reason: "action cancelled" }); continue; }
    const qty = Number(a.approved_qty != null ? a.approved_qty : a.suggested_qty) || 0;
    if (qty <= 0) { skipped.push({ action_id: a.id, reason: "zero approved qty" }); continue; }
    if (!a.sku_id || !imById.has(a.sku_id)) { skipped.push({ action_id: a.id, reason: "SKU not found in item master" }); continue; }
    if (!a.vendor_id) { skipped.push({ action_id: a.id, reason: "no vendor assigned on action" }); continue; }
    const vm = vmById.get(a.vendor_id);
    if (!vm || !vm.portal_vendor_id) {
      skipped.push({ action_id: a.id, reason: `planning vendor ${vm ? vm.vendor_code : a.vendor_id} has no Tangerine vendor link (set ip_vendor_master.portal_vendor_id)` });
      continue;
    }
    const im = imById.get(a.sku_id);
    const unitCostCents = Math.round(Number(im.unit_cost || 0) * 100);
    if (unitCostCents <= 0) warnings.push({ action_id: a.id, message: `SKU ${im.sku_code} has no unit cost — PO line created at $0 (edit before issuing)` });

    const g = byVendor.get(vm.portal_vendor_id) || { vendor_name: vm.name, period_starts: [], lines: [] };
    g.lines.push({ action_id: a.id, inventory_item_id: a.sku_id, sku_code: im.sku_code, qty, unit_cost_cents: unitCostCents });
    if (a.period_start) g.period_starts.push(a.period_start);
    byVendor.set(vm.portal_vendor_id, g);
  }

  if (byVendor.size === 0) {
    return res.status(200).json({ dry_run: dryRun, created: [], skipped, warnings, message: "No eligible actions to create POs from (see skipped)." });
  }

  // ── Entity (ROF) ────────────────────────────────────────────────────────
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const today = new Date().toISOString().slice(0, 10);

  // ── Create one draft PO per vendor (or preview) ─────────────────────────
  const created = [];
  for (const [vendorId, g] of byVendor.entries()) {
    const lineRows = g.lines.map((l, i) => ({
      line_number: i + 1, inventory_item_id: l.inventory_item_id, description: l.sku_code,
      qty_ordered: l.qty, unit_cost_cents: l.unit_cost_cents, line_total_cents: Math.round(l.qty * l.unit_cost_cents),
    }));
    const subtotal = lineRows.reduce((s, l) => s + l.line_total_cents, 0);
    const expected = g.period_starts.length ? g.period_starts.slice().sort()[0] : null;

    if (dryRun) {
      created.push({ vendor_id: vendorId, vendor_name: g.vendor_name, line_count: lineRows.length, total_cents: subtotal, expected_date: expected, preview: true });
      continue;
    }

    const { data: header, error: hErr } = await admin.from("purchase_orders").insert({
      entity_id: entity.id, vendor_id: vendorId, order_date: today, expected_date: expected,
      status: "draft", currency: "USD", subtotal_cents: subtotal, total_cents: subtotal,
      notes: `From planning buy plan "${batch.batch_name}" (${batch.id})`,
    }).select("id, status").single();
    if (hErr) { return res.status(500).json({ error: `PO header insert failed for vendor ${vendorId}: ${hErr.message}`, created, skipped }); }

    const { error: lErr } = await admin.from("purchase_order_lines")
      .insert(lineRows.map((l) => ({ ...l, purchase_order_id: header.id })));
    if (lErr) { await admin.from("purchase_orders").delete().eq("id", header.id); return res.status(500).json({ error: `PO lines insert failed: ${lErr.message}`, created, skipped }); }

    // Link each action to the created PO + mark succeeded.
    const stamp = new Date().toISOString();
    for (const l of g.lines) {
      await admin.from("ip_execution_actions").update({
        execution_status: "succeeded",
        response_json: { tangerine_po_id: header.id, created_at: stamp, target: "tangerine_native_po" },
      }).eq("id", l.action_id);
    }
    created.push({ vendor_id: vendorId, vendor_name: g.vendor_name, po_id: header.id, po_status: header.status, line_count: lineRows.length, total_cents: subtotal, expected_date: expected });
  }

  return res.status(dryRun ? 200 : 201).json({
    dry_run: dryRun, created, skipped, warnings,
    message: dryRun
      ? `Preview: ${created.length} draft PO(s) across ${created.length} vendor(s), ${skipped.length} action(s) skipped.`
      : `Created ${created.length} draft Tangerine PO(s); review + issue them in Procurement → Purchase Orders. ${skipped.length} action(s) skipped.`,
  });
}
