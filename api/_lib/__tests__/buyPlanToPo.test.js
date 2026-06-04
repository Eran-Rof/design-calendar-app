import { describe, it, expect } from "vitest";
import {
  planBuyPlanPos,
  resolveUnitCostCents,
  matchTangerineVendor,
  SKIP_CODES,
} from "../buyPlanToPo.js";

const VM_LINKED = { id: "vm1", vendor_code: "ACME", name: "Acme Mfg", portal_vendor_id: "tv1" };
const VM_UNLINKED = { id: "vm2", vendor_code: "BETA", name: "Beta Co", portal_vendor_id: null };
const IM1 = { id: "sku1", sku_code: "RYB1-BLACK-32", unit_cost: 4.5 };
const IM2 = { id: "sku2", sku_code: "RYB2-BLUE-34", unit_cost: 0 };

function vmMap() { return new Map([["vm1", VM_LINKED], ["vm2", VM_UNLINKED]]); }
function imMap() { return new Map([["sku1", IM1], ["sku2", IM2]]); }

function action(over = {}) {
  return {
    id: over.id || "a1", sku_id: "sku1", vendor_id: "vm1",
    suggested_qty: 100, approved_qty: null, execution_status: "approved",
    period_start: "2026-07-01", response_json: null, ...over,
  };
}

describe("resolveUnitCostCents", () => {
  it("prefers item-master unit_cost", () => {
    expect(resolveUnitCostCents({ unit_cost: 4.5 }, { avg_cost: 9 })).toEqual({ cents: 450, source: "item_master" });
  });
  it("falls back to avg_cost when unit_cost is 0/missing", () => {
    expect(resolveUnitCostCents({ unit_cost: 0 }, { avg_cost: 4.8229 })).toEqual({ cents: 482, source: "avg_cost" });
  });
  it("falls back to standard_unit_price last", () => {
    expect(resolveUnitCostCents({}, { standard_unit_price: 6.25 })).toEqual({ cents: 625, source: "standard_price" });
  });
  it("returns 0/none when nothing is available", () => {
    expect(resolveUnitCostCents({ unit_cost: 0 }, null)).toEqual({ cents: 0, source: "none" });
  });
});

describe("planBuyPlanPos grouping", () => {
  it("groups eligible actions by portal vendor and sums line totals", () => {
    const actions = [
      action({ id: "a1", sku_id: "sku1", vendor_id: "vm1", approved_qty: 10 }),
      action({ id: "a2", sku_id: "sku1", vendor_id: "vm1", approved_qty: 5 }),
    ];
    const { byVendor, skipped, diagnostics } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap() });
    expect(byVendor.size).toBe(1);
    const g = byVendor.get("tv1");
    expect(g.lines).toHaveLength(2);
    expect(g.lines[0].unit_cost_cents).toBe(450);
    expect(skipped).toHaveLength(0);
    expect(diagnostics.eligible_lines).toBe(2);
  });

  it("uses approved_qty over suggested_qty, and skips zero-qty", () => {
    const actions = [
      action({ id: "a1", approved_qty: 0, suggested_qty: 99 }),
      action({ id: "a2", approved_qty: 7, suggested_qty: 1 }),
    ];
    const { byVendor, skipped } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap() });
    expect(skipped.find((s) => s.action_id === "a1").code).toBe(SKIP_CODES.ZERO_QTY);
    expect(byVendor.get("tv1").lines[0].qty).toBe(7);
  });
});

describe("planBuyPlanPos skip reasons", () => {
  it("skips an unlinked planning vendor with planning_vendor_id for the link affordance", () => {
    const actions = [action({ vendor_id: "vm2" })];
    const { skipped, byVendor, referencedVendors } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap() });
    expect(byVendor.size).toBe(0);
    const s = skipped[0];
    expect(s.code).toBe(SKIP_CODES.VENDOR_UNLINKED);
    expect(s.planning_vendor_id).toBe("vm2");
    expect(referencedVendors.has("vm2")).toBe(true);
  });
  it("skips when no vendor on the action", () => {
    const { skipped } = planBuyPlanPos({ actions: [action({ vendor_id: null })], vmById: vmMap(), imById: imMap() });
    expect(skipped[0].code).toBe(SKIP_CODES.NO_VENDOR);
  });
  it("skips when SKU is not in item master", () => {
    const { skipped } = planBuyPlanPos({ actions: [action({ sku_id: "ghost" })], vmById: vmMap(), imById: imMap() });
    expect(skipped[0].code).toBe(SKIP_CODES.NO_SKU);
  });
  it("skips a cancelled action", () => {
    const { skipped } = planBuyPlanPos({ actions: [action({ execution_status: "cancelled" })], vmById: vmMap(), imById: imMap() });
    expect(skipped[0].code).toBe(SKIP_CODES.CANCELLED);
  });
});

describe("planBuyPlanPos idempotency + cost fallback", () => {
  it("skips an action already linked to a still-existing PO", () => {
    const actions = [action({ response_json: { tangerine_po_id: "po9" } })];
    const { skipped } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap(), existingPoIds: new Set(["po9"]) });
    expect(skipped[0].code).toBe(SKIP_CODES.ALREADY_LINKED);
  });
  it("re-plans an action whose linked PO was deleted", () => {
    const actions = [action({ response_json: { tangerine_po_id: "po9" } })];
    const { byVendor, skipped } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap(), existingPoIds: new Set([]) });
    expect(skipped).toHaveLength(0);
    expect(byVendor.get("tv1").lines).toHaveLength(1);
  });
  it("warns (does not skip) on a $0 line when no cost source resolves", () => {
    const actions = [action({ sku_id: "sku2" })];
    const avg = new Map(); // no avg cost for sku2
    const { byVendor, warnings } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap(), avgBySku: avg });
    expect(byVendor.get("tv1").lines[0].unit_cost_cents).toBe(0);
    expect(warnings).toHaveLength(1);
  });
  it("recovers a $0 item-master cost from avg_cost", () => {
    const actions = [action({ sku_id: "sku2" })];
    const avg = new Map([["RYB2-BLUE-34", { avg_cost: 4.8229 }]]);
    const { byVendor, warnings } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap(), avgBySku: avg });
    expect(byVendor.get("tv1").lines[0].unit_cost_cents).toBe(482);
    expect(byVendor.get("tv1").lines[0].cost_source).toBe("avg_cost");
    expect(warnings).toHaveLength(0);
  });
});

describe("matchTangerineVendor", () => {
  const tvs = [
    { id: "t1", name: "Acme Mfg", code: "ACME", aliases: ["acme manufacturing"] },
    { id: "t2", name: "Other Co", code: "OTH", aliases: [] },
  ];
  it("matches on code", () => {
    expect(matchTangerineVendor({ vendor_code: "acme", name: "x" }, tvs)).toEqual([{ id: "t1", name: "Acme Mfg", code: "ACME", match_on: "code" }]);
  });
  it("matches on name when code differs", () => {
    expect(matchTangerineVendor({ vendor_code: "zzz", name: "Acme Mfg" }, tvs)[0].match_on).toBe("name");
  });
  it("matches on alias", () => {
    expect(matchTangerineVendor({ vendor_code: "zzz", name: "Acme Manufacturing" }, tvs)[0].match_on).toBe("alias");
  });
  it("returns [] when nothing matches", () => {
    expect(matchTangerineVendor({ vendor_code: "nope", name: "nobody" }, tvs)).toEqual([]);
  });
});
