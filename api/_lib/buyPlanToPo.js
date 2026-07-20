// api/_lib/buyPlanToPo.js
//
// Pure core for M31 direction-A (Inventory-Planning buy plan → DRAFT native
// Tangerine purchase orders). Lifted out of the route handler so the
// grouping / cost-fallback / skip-reason / idempotency logic is
// unit-testable without a Supabase client. The handler does the IO (load
// actions + vendor master + item master + avg costs + Tangerine vendors,
// insert POs, stamp actions) and calls planBuyPlanPos for the decisions.
//
// DO NOT add a Supabase client / res-req args here — keep it framework-
// agnostic (mirrors the planning-sync.js split).

import { styleKey, resolvePackSize, poFallbackCostForRow } from "./poCostFallback.js";

// Skip codes — coarse categories so the UI can render a "why nothing was
// created" breakdown without parsing free-text reasons.
export const SKIP_CODES = {
  ALREADY_LINKED: "already_linked",
  CANCELLED: "cancelled",
  ZERO_QTY: "zero_qty",
  NO_SKU: "no_sku",
  NO_VENDOR: "no_vendor",
  VENDOR_MISSING: "vendor_missing",
  VENDOR_UNLINKED: "vendor_unlinked",
  NO_COST_SIGNAL: "no_cost_signal",
};

// Resolve a PO-line unit cost (cents) for a SKU, falling back through the
// available cost sources so a missing ip_item_master.unit_cost doesn't
// silently produce a $0 line. This mirrors the wholesale grid's shared
// cascade (PR #1852) so a pushed PO line costs the same as the grid shows.
//
// When the buy plan's run has a VENDOR selected (build_vendor_id), two
// vendor-first tiers are tried BEFORE anything else so a pushed line costs the
// same as the vendor-first grid (CEO ask, #1855): vendor OPEN-PO cost, then
// vendor most-recent RECEIVED-PO cost. After those:
//   item-master unit_cost → avg → standard price → sibling-color avg →
//   grain-aware any-vendor open-PO fallback → 0 (caller hard-blocks the line).
// All vendor / sibling / po_fallback tiers are pre-resolved dollar candidates
// the caller derives from the pre-built lookup maps — this stays pure.
export function resolveUnitCostCents(im, avgRow, extra = {}) {
  const tries = [
    [extra.vendorOpenDollars, "vendor_open_po"],
    [extra.vendorRecvDollars, "vendor_received_po"],
    [im && im.unit_cost, "item_master"],
    [avgRow && avgRow.avg_cost, "avg_cost"],
    [avgRow && avgRow.standard_unit_price, "standard_price"],
    [extra.siblingAvgDollars, "sibling_avg"],
    [extra.poFallbackDollars, "po_fallback"],
  ];
  for (const [dollars, source] of tries) {
    const cents = Math.round(Number(dollars || 0) * 100);
    if (cents > 0) return { cents, source };
  }
  return { cents: 0, source: "none" };
}

// Match a planning vendor to candidate Tangerine vendors by exact code,
// name, or alias (all case-insensitive). Read-only suggestion used to make
// the "vendor not linked" skip actionable — the operator confirms the link.
export function matchTangerineVendor(vm, tangerineVendors) {
  const code = (vm.vendor_code || "").trim().toLowerCase();
  const name = (vm.name || "").trim().toLowerCase();
  const out = [];
  for (const tv of tangerineVendors || []) {
    const tcode = (tv.code || "").trim().toLowerCase();
    const tname = (tv.name || "").trim().toLowerCase();
    const aliases = Array.isArray(tv.aliases) ? tv.aliases.map((x) => String(x).trim().toLowerCase()) : [];
    let matchOn = null;
    if (code && tcode && code === tcode) matchOn = "code";
    else if (name && tname && name === tname) matchOn = "name";
    else if (name && aliases.includes(name)) matchOn = "alias";
    if (matchOn) out.push({ id: tv.id, name: tv.name, code: tv.code, match_on: matchOn });
  }
  return out;
}

// Group eligible create_buy_request actions by Tangerine vendor, deciding
// which to skip (and why) and resolving each line's cost.
//
//   actions            — ip_execution_actions rows (create_buy_request)
//   vmById             — Map<ip_vendor_master.id, vendorMasterRow>
//   imById             — Map<ip_item_master.id, itemMasterRow> (rows carry
//                        sku_code, style_code, unit_cost, pack_size)
//   avgBySku           — Map<sku_code, ip_item_avg_cost row>  (optional)
//   existingPoIds      — Set<purchase_orders.id> still present (optional). When
//                        a previously-linked PO id is NOT in the set, the draft
//                        was deleted in Procurement, so the action is re-planned
//                        instead of skipped (re-create safety).
//   poEachByBaseColor  — Map<baseColorKey, per-each open-PO cost $> (optional)
//   poEachByStyle      — Map<styleKey, per-each open-PO cost $>     (optional)
//   prepackUnitsPerPack — Map<lowercased ppk_style_code, units-per-pack>
//                        (optional; used to re-grain the PO fallback)
//
// The last three feed the grain-aware open-PO cost tier — see
// api/_lib/poCostFallback.js. All are pre-built maps (this stays pure/IO-free).
//
// Returns { byVendor: Map<portal_vendor_id, group>, skipped, warnings,
//           referencedVendors: Map<vm.id, vm>, diagnostics }.
// vendorOpen* / vendorRecv* (all optional) are the vendor-first tiers built
// from the run's selected vendor's PO lines (open weighted-avg per-each,
// received most-recent per-each). When present, a line tries them before every
// other cost source. Absent (no vendor on the run) => behavior is unchanged.
export function planBuyPlanPos({ actions, vmById, imById, avgBySku, existingPoIds,
  poEachByBaseColor, poEachByStyle, prepackUnitsPerPack,
  vendorOpenByBaseColor, vendorOpenByStyle, vendorRecvByBaseColor, vendorRecvByStyle } = {}) {
  const skipped = [];
  const warnings = [];
  const byVendor = new Map();
  const referencedVendors = new Map();
  const acts = actions || [];

  // Sibling-color avg cost keyed by style: the first child SKU in a style
  // whose avg cost is usable. Lets a half-provisioned colorway (all costs
  // NULL) inherit a sibling color's avg. Built from the items already loaded
  // for this buy (imById) + their avg costs (avgBySku) — no extra IO. A line
  // only ever reaches this tier when its OWN avg is absent (see the cascade),
  // so an item never "borrows" its own avg here.
  const siblingAvgByStyle = new Map();
  for (const im of imById ? imById.values() : []) {
    if (!im || !im.sku_code) continue;
    const dollars = avgBySku && avgBySku.get(im.sku_code) ? Number(avgBySku.get(im.sku_code).avg_cost) : 0;
    if (!(dollars > 0)) continue;
    const sKey = styleKey(im.sku_code);
    if (sKey && !siblingAvgByStyle.has(sKey)) siblingAvgByStyle.set(sKey, dollars);
  }

  for (const a of acts) {
    const linkedPo = a.response_json && a.response_json.tangerine_po_id;
    if (linkedPo && (!existingPoIds || existingPoIds.has(linkedPo))) {
      skipped.push({ action_id: a.id, code: SKIP_CODES.ALREADY_LINKED, reason: "already linked to a Tangerine PO", po_id: linkedPo });
      continue;
    }
    if (a.execution_status === "cancelled") {
      skipped.push({ action_id: a.id, code: SKIP_CODES.CANCELLED, reason: "action cancelled" });
      continue;
    }
    const qty = Number(a.approved_qty != null ? a.approved_qty : a.suggested_qty) || 0;
    if (qty <= 0) {
      skipped.push({ action_id: a.id, code: SKIP_CODES.ZERO_QTY, reason: "zero approved qty" });
      continue;
    }
    if (!a.sku_id || !imById.has(a.sku_id)) {
      skipped.push({ action_id: a.id, code: SKIP_CODES.NO_SKU, reason: "SKU not found in item master" });
      continue;
    }
    if (!a.vendor_id) {
      skipped.push({ action_id: a.id, code: SKIP_CODES.NO_VENDOR, reason: "no vendor on this buy action (assign a vendor in the buy plan, or populate ip_vendor_master)" });
      continue;
    }
    const vm = vmById.get(a.vendor_id);
    if (!vm) {
      skipped.push({ action_id: a.id, code: SKIP_CODES.VENDOR_MISSING, reason: `vendor ${a.vendor_id} not found in ip_vendor_master` });
      continue;
    }
    referencedVendors.set(vm.id, vm);
    if (!vm.portal_vendor_id) {
      skipped.push({
        action_id: a.id, code: SKIP_CODES.VENDOR_UNLINKED, planning_vendor_id: vm.id,
        reason: `planning vendor "${vm.vendor_code || vm.name}" is not linked to a Tangerine vendor (set its Tangerine link)`,
      });
      continue;
    }
    const im = imById.get(a.sku_id);
    // Shared cost cascade (mirrors the wholesale grid, PR #1852): direct
    // item-master / avg / standard → sibling-color avg → grain-aware open-PO
    // fallback. The last two are derived here from the pre-built maps and
    // handed to resolveUnitCostCents as dollar candidates.
    const sKey = styleKey(im.sku_code);
    const siblingAvgDollars = sKey ? siblingAvgByStyle.get(sKey) : null;
    const packSize = resolvePackSize(im.sku_code, im.pack_size, prepackUnitsPerPack);
    const poFallbackDollars = poFallbackCostForRow(im.sku_code, packSize, poEachByBaseColor, poEachByStyle);
    // Vendor-first tiers (only populated when the run has a vendor selected).
    const vendorOpenDollars = poFallbackCostForRow(im.sku_code, packSize, vendorOpenByBaseColor, vendorOpenByStyle);
    const vendorRecvDollars = poFallbackCostForRow(im.sku_code, packSize, vendorRecvByBaseColor, vendorRecvByStyle);
    const { cents: unitCostCents, source: costSource } =
      resolveUnitCostCents(im, avgBySku && avgBySku.get(im.sku_code), { vendorOpenDollars, vendorRecvDollars, siblingAvgDollars, poFallbackDollars });
    if (unitCostCents <= 0) {
      // Hard block: never push a $0-cost line. Skip it (coded) so the rest of
      // the buy still creates its POs, and surface the SKU in the diagnostics.
      skipped.push({
        action_id: a.id, code: SKIP_CODES.NO_COST_SIGNAL, sku_code: im.sku_code,
        reason: `SKU ${im.sku_code} has no resolvable cost in any source (item master / avg / sibling color / open PO) — line skipped, not pushed at $0 (add a cost, then re-run)`,
      });
      continue;
    }

    const g = byVendor.get(vm.portal_vendor_id) || { vendor_name: vm.name, planning_vendor_id: vm.id, period_starts: [], lines: [] };
    g.lines.push({ action_id: a.id, inventory_item_id: a.sku_id, sku_code: im.sku_code, qty, unit_cost_cents: unitCostCents, cost_source: costSource });
    if (a.period_start) g.period_starts.push(a.period_start);
    byVendor.set(vm.portal_vendor_id, g);
  }

  const skip_breakdown = {};
  for (const s of skipped) skip_breakdown[s.code] = (skip_breakdown[s.code] || 0) + 1;
  const diagnostics = {
    actions_total: acts.length,
    vendors: byVendor.size,
    eligible_lines: [...byVendor.values()].reduce((n, g) => n + g.lines.length, 0),
    skipped: skipped.length,
    warnings: warnings.length,
    skip_breakdown,
  };

  return { byVendor, skipped, warnings, referencedVendors, diagnostics };
}
