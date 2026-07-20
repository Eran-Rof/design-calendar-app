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
//     vendor = ip_vendor_master.portal_vendor_id (→ vendors.id); unit cost is
//     resolved through the SAME shared cascade the wholesale grid uses (PR
//     #1852): ip_item_master.unit_cost → ip_item_avg_cost.avg_cost / standard
//     price → sibling-color avg → grain-aware open-PO fallback. A line that
//     still resolves to $0 is HARD-BLOCKED (skipped no_cost_signal), never
//     pushed at $0.
//   • Groups eligible actions by Tangerine vendor → ONE draft PO per vendor with
//     N lines. POs are created `status='draft'` (no po_number, no commitments) —
//     the operator reviews + issues them in the Tangerine Procurement PO panel.
//   • Idempotent: an action already linked to a still-existing PO
//     (response_json.tangerine_po_id) is skipped; if that PO was deleted the
//     action is re-planned. Actions with no vendor / no portal link / zero qty
//     are skipped with a coded reason. For unlinked planning vendors the
//     response carries read-only Tangerine-vendor match suggestions so the
//     operator can link them. dry_run previews without writing.
//
// Decision/cost/skip logic lives in api/_lib/buyPlanToPo.js (pure, unit-tested);
// this handler only does IO + grouping → inserts. No Xoro involvement.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";
import { planBuyPlanPos, matchTangerineVendor } from "../../../_lib/buyPlanToPo.js";
import { buildPoEachCostByBaseColor, buildPoEachCostByStyle, resolvePackSize } from "../../../_lib/poCostFallback.js";
import { notifyProductionManager } from "../../../_lib/notifyProductionManager.js";

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

// Chunk a column-IN lookup into ≤100-id batches (PostgREST URL-length guard;
// see the by-size cutover lesson where a single wide .in() 400'd).
async function fetchByIds(admin, table, select, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from(table).select(select).in("id", ids.slice(i, i + 100));
    if (data) out.push(...data);
  }
  return out;
}
async function fetchAvgCosts(admin, skuCodes) {
  const out = new Map();
  for (let i = 0; i < skuCodes.length; i += 100) {
    const { data } = await admin.from("ip_item_avg_cost")
      .select("sku_code, avg_cost, standard_unit_price").in("sku_code", skuCodes.slice(i, i + 100));
    for (const r of data || []) out.set(r.sku_code, r);
  }
  return out;
}

// Page a PostgREST query past the 1000-row default cap. `q()` builds a fresh
// query for a given [from,to] range so each page is a clean request.
async function fetchAllPaged(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await q().range(from, from + 999);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Units-per-pack for every active Prepack Matrix, keyed by lowercased
// ppk_style_code (units = Σ qty_per_pack across the matrix's sizes). Mirrors
// wholesalePlanningRepository.listPrepackUnitsPerPack so the push re-grains the
// open-PO fallback the same way the grid does.
async function fetchPrepackUnitsPerPack(admin) {
  const out = new Map();
  const matrices = await fetchAllPaged(() => admin.from("prepack_matrices")
    .select("id, ppk_style_code").eq("is_active", true).not("ppk_style_code", "is", null));
  if (matrices.length === 0) return out;
  const byId = new Map(matrices.map((m) => [m.id, m]));
  const ids = matrices.map((m) => m.id);
  const unitsByMatrix = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: sizes } = await admin.from("prepack_matrix_sizes")
      .select("matrix_id, qty_per_pack").in("matrix_id", ids.slice(i, i + 100));
    for (const s of sizes || []) {
      const q = Number(s.qty_per_pack) || 0;
      if (q > 0) unitsByMatrix.set(s.matrix_id, (unitsByMatrix.get(s.matrix_id) || 0) + q);
    }
  }
  for (const [id, units] of unitsByMatrix) {
    const m = byId.get(id);
    if (m && m.ppk_style_code && units > 0) out.set(m.ppk_style_code.trim().toLowerCase(), units);
  }
  return out;
}

// Build the open-PO cost rows (PoCostRow shape) for every style in the buy
// plan. Open POs may sit on a SIBLING color or the pack-grain PPK twin — not
// just the buy-plan skus — so the universe is every ip_item_master row in the
// plan's styles, then their open POs. Each row's pack size is resolved (prefer
// the prepack matrix) so the per-each math is grain-correct.
async function fetchOpenPoCostRows(admin, styleCodes, prepackUnitsPerPack) {
  if (!styleCodes.length) return [];
  const styleItems = [];
  for (let i = 0; i < styleCodes.length; i += 100) {
    const chunk = styleCodes.slice(i, i + 100);
    styleItems.push(...await fetchAllPaged(() => admin.from("ip_item_master")
      .select("id, sku_code, pack_size").in("style_code", chunk)));
  }
  if (!styleItems.length) return [];
  const itemById = new Map(styleItems.map((it) => [it.id, it]));
  const skuIds = styleItems.map((it) => it.id);
  const rows = [];
  for (let i = 0; i < skuIds.length; i += 100) {
    const chunk = skuIds.slice(i, i + 100);
    const pos = await fetchAllPaged(() => admin.from("ip_open_purchase_orders")
      .select("sku_id, unit_cost, qty_open").in("sku_id", chunk));
    for (const p of pos) {
      const it = itemById.get(p.sku_id);
      const skuCode = it && it.sku_code ? it.sku_code : "";
      if (!skuCode) continue;
      rows.push({
        sku_code: skuCode,
        unit_cost: p.unit_cost == null ? null : Number(p.unit_cost),
        qty_open: p.qty_open == null ? null : Number(p.qty_open),
        pack_size: resolvePackSize(skuCode, it.pack_size == null ? null : Number(it.pack_size), prepackUnitsPerPack),
      });
    }
  }
  return rows;
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

  // The planner who is pushing — recorded on each PO so the approve/reject
  // outcome can be routed back to them. Trusted from the header the same way
  // the planning permission check reads it (checkPermission above).
  const pusherEmail = (req.headers["x-user-email"] || "").toString().trim() || null;

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

  // ── Resolve vendor portal links, item costs, avg-cost fallback ──────────
  const vendorIds = [...new Set(actions.map((a) => a.vendor_id).filter(Boolean))];
  const skuIds = [...new Set(actions.map((a) => a.sku_id).filter(Boolean))];
  const vmRows = vendorIds.length ? await fetchByIds(admin, "ip_vendor_master", "id, vendor_code, name, portal_vendor_id", vendorIds) : [];
  const vmById = new Map(vmRows.map((v) => [v.id, v]));
  const imRows = skuIds.length ? await fetchByIds(admin, "ip_item_master", "id, sku_code, unit_cost, style_code, pack_size", skuIds) : [];
  const imById = new Map(imRows.map((i) => [i.id, i]));
  const avgBySku = await fetchAvgCosts(admin, [...new Set(imRows.map((i) => i.sku_code).filter(Boolean))]);

  // Grain-aware open-PO cost fallback inputs (mirrors the wholesale grid, PR
  // #1852): per-each open-PO cost keyed by base-color then style, re-grained by
  // each line's pack size. Loaded across every style in the buy plan so a
  // half-provisioned colorway can inherit a sibling color's / the PPK twin's PO
  // cost instead of pushing a $0 line.
  const prepackUnitsPerPack = await fetchPrepackUnitsPerPack(admin);
  const styleCodes = [...new Set(imRows.map((i) => i.style_code).filter(Boolean))];
  const poCostRows = await fetchOpenPoCostRows(admin, styleCodes, prepackUnitsPerPack);
  const poEachByBaseColor = buildPoEachCostByBaseColor(poCostRows);
  const poEachByStyle = buildPoEachCostByStyle(poCostRows);

  // Idempotency re-check: which previously-linked PO ids still exist.
  const linkedPoIds = [...new Set(actions.map((a) => a.response_json && a.response_json.tangerine_po_id).filter(Boolean))];
  let existingPoIds;
  if (linkedPoIds.length) {
    const live = await fetchByIds(admin, "purchase_orders", "id", linkedPoIds);
    existingPoIds = new Set(live.map((p) => p.id));
  }

  const { byVendor, skipped, warnings, referencedVendors, diagnostics } =
    planBuyPlanPos({ actions, vmById, imById, avgBySku, existingPoIds, poEachByBaseColor, poEachByStyle, prepackUnitsPerPack });

  // ── Vendor link suggestions for unlinked referenced vendors ─────────────
  let vendor_suggestions = [];
  const unlinked = [...referencedVendors.values()].filter((vm) => !vm.portal_vendor_id);
  if (unlinked.length) {
    const { data: tvs } = await admin.from("vendors").select("id, name, code, aliases").is("deleted_at", null);
    vendor_suggestions = unlinked.map((vm) => ({
      planning_vendor_id: vm.id, vendor_code: vm.vendor_code, name: vm.name,
      candidates: matchTangerineVendor(vm, tvs || []),
    }));
  }

  if (byVendor.size === 0) {
    return res.status(200).json({
      dry_run: dryRun, created: [], skipped, warnings, vendor_suggestions, diagnostics,
      message: "No eligible actions to create POs from (see skipped / vendor_suggestions).",
    });
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
      // Planning-pushed PO → needs Production Manager sign-off before it can be
      // issued (gated in purchase-orders/[id].js). Manually-created POs default
      // requires_production_approval=false and are unaffected.
      requires_production_approval: true,
      production_approval_status: "pending",
      production_requested_by: pusherEmail,
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

  // ── Notify the Production Manager: these drafts need sign-off before issue ─
  // Best-effort; never fails the push. One summary notification per push,
  // deep-linked to the pending-approval worklist.
  let production_manager_notified = null;
  const madePos = created.filter((c) => c.po_id);
  if (!dryRun && madePos.length > 0) {
    const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : null);
    const n = madePos.length;
    production_manager_notified = await notifyProductionManager(admin, origin, {
      event_type: "po_production_approval_requested",
      title: `${n} purchase order${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} your approval`,
      body: `${n} draft purchase order${n === 1 ? "" : "s"} from the planning buy plan "${batch.batch_name}" ${n === 1 ? "is" : "are"} waiting for Production Manager approval before ${n === 1 ? "it" : "they"} can be issued. Review in Tangerine → Procurement → Purchase Orders.`,
      link: "/tangerine?m=purchase_orders&approval=pending",
      metadata: { batch_id: batch.id, batch_name: batch.batch_name, po_ids: madePos.map((c) => c.po_id) },
      dedupe_key: `po_production_approval_${batch.id}`,
    });
  }

  return res.status(dryRun ? 200 : 201).json({
    dry_run: dryRun, created, skipped, warnings, vendor_suggestions, diagnostics, production_manager_notified,
    message: dryRun
      ? `Preview: ${created.length} draft PO(s) across ${created.length} vendor(s), ${skipped.length} action(s) skipped.`
      : `Created ${created.length} draft Tangerine PO(s); review + issue them in Procurement → Purchase Orders. ${skipped.length} action(s) skipped.`,
  });
}
