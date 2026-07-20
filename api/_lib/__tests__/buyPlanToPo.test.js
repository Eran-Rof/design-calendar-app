import { describe, it, expect } from "vitest";
import {
  planBuyPlanPos,
  resolveUnitCostCents,
  matchTangerineVendor,
  SKIP_CODES,
} from "../buyPlanToPo.js";
import {
  buildPoEachCostByBaseColor,
  buildPoEachCostByStyle,
  resolvePackSize,
} from "../poCostFallback.js";

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
  it("falls back to sibling_avg after standard_price", () => {
    expect(resolveUnitCostCents({ unit_cost: 0 }, null, { siblingAvgDollars: 3, poFallbackDollars: 9 }))
      .toEqual({ cents: 300, source: "sibling_avg" });
  });
  it("falls back to po_fallback last, before $0", () => {
    expect(resolveUnitCostCents({ unit_cost: 0 }, null, { poFallbackDollars: 9 }))
      .toEqual({ cents: 900, source: "po_fallback" });
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
  it("hard-blocks a $0 line (no cost source resolves) with a coded skip", () => {
    const actions = [action({ sku_id: "sku2" })];
    const avg = new Map(); // no avg cost for sku2
    const { byVendor, skipped, warnings, diagnostics } = planBuyPlanPos({ actions, vmById: vmMap(), imById: imMap(), avgBySku: avg });
    expect(byVendor.size).toBe(0); // line NOT created at $0
    expect(skipped[0].code).toBe(SKIP_CODES.NO_COST_SIGNAL);
    expect(skipped[0].sku_code).toBe("RYB2-BLUE-34"); // sku surfaced for the diagnostics list
    expect(warnings).toHaveLength(0);
    expect(diagnostics.skip_breakdown.no_cost_signal).toBe(1);
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

describe("planBuyPlanPos cost cascade — sibling + open-PO tiers", () => {
  // Two colors of one style; the blue is the buy line, the red is a sibling.
  const IM_RED = { id: "skuA", sku_code: "STY9-RED-M", style_code: "STY9", unit_cost: 0, pack_size: 1 };
  const IM_BLUE = { id: "skuB", sku_code: "STY9-BLUE-M", style_code: "STY9", unit_cost: 0, pack_size: 1 };
  function styleMap() { return new Map([["skuA", IM_RED], ["skuB", IM_BLUE]]); }
  const blueAction = action({ id: "a1", sku_id: "skuB", vendor_id: "vm1" });

  it("(a) sibling-color avg — a colorway with no own cost inherits a sibling color's avg", () => {
    const avg = new Map([["STY9-RED-M", { avg_cost: 7 }]]); // only the sibling has an avg
    const { byVendor } = planBuyPlanPos({ actions: [blueAction], vmById: vmMap(), imById: styleMap(), avgBySku: avg });
    const line = byVendor.get("tv1").lines[0];
    expect(line.unit_cost_cents).toBe(700);
    expect(line.cost_source).toBe("sibling_avg");
  });

  it("(b) grain-aware open-PO fallback — a PPK PO price re-grains to an each line (wrong item pack_size healed by matrix)", () => {
    // The PPK style packs 6 units; the PPK twin's item-master pack_size is WRONG
    // (1). resolvePackSize heals it from the matrix so per-each = $60/6 = $10.
    const matrix = new Map([["ryb0412ppk", 6]]);
    const packSize = resolvePackSize("RYB0412PPK-BLACK", 1, matrix);
    expect(packSize).toBe(6);
    const poRows = [{ sku_code: "RYB0412PPK-BLACK", unit_cost: 60, qty_open: 10, pack_size: packSize }];
    const poEachByBaseColor = buildPoEachCostByBaseColor(poRows);
    const poEachByStyle = buildPoEachCostByStyle(poRows);
    const imEach = { id: "skuE", sku_code: "RYB0412-BLACK-M", style_code: "RYB0412", unit_cost: 0, pack_size: 1 };
    const actions = [action({ id: "a1", sku_id: "skuE", vendor_id: "vm1" })];
    const { byVendor } = planBuyPlanPos({
      actions, vmById: vmMap(), imById: new Map([["skuE", imEach]]), avgBySku: new Map(),
      poEachByBaseColor, poEachByStyle, prepackUnitsPerPack: matrix,
    });
    const line = byVendor.get("tv1").lines[0];
    // per-each $10 re-grained to the each line's own pack size (1) → $10
    expect(line.unit_cost_cents).toBe(1000);
    expect(line.cost_source).toBe("po_fallback");
  });

  it("precedence — direct own avg beats sibling avg beats open-PO fallback", () => {
    const avg = new Map([
      ["STY9-RED-M", { avg_cost: 5 }],  // sibling
      ["STY9-BLUE-M", { avg_cost: 8 }], // the buy line's OWN direct avg
    ]);
    const poRows = [{ sku_code: "STY9-BLUE-M", unit_cost: 99, qty_open: 1, pack_size: 1 }];
    const { byVendor } = planBuyPlanPos({
      actions: [blueAction], vmById: vmMap(), imById: styleMap(), avgBySku: avg,
      poEachByBaseColor: buildPoEachCostByBaseColor(poRows), poEachByStyle: buildPoEachCostByStyle(poRows),
    });
    const line = byVendor.get("tv1").lines[0];
    expect(line.cost_source).toBe("avg_cost"); // own avg wins over sibling + PO
    expect(line.unit_cost_cents).toBe(800);
  });

  it("precedence — sibling avg beats open-PO fallback when own avg is absent", () => {
    const avg = new Map([["STY9-RED-M", { avg_cost: 5 }]]); // only the sibling has an avg
    const poRows = [{ sku_code: "STY9-BLUE-M", unit_cost: 99, qty_open: 1, pack_size: 1 }];
    const { byVendor } = planBuyPlanPos({
      actions: [blueAction], vmById: vmMap(), imById: styleMap(), avgBySku: avg,
      poEachByBaseColor: buildPoEachCostByBaseColor(poRows), poEachByStyle: buildPoEachCostByStyle(poRows),
    });
    const line = byVendor.get("tv1").lines[0];
    expect(line.cost_source).toBe("sibling_avg"); // sibling wins over the PO fallback
    expect(line.unit_cost_cents).toBe(500);
  });

  it("open-PO fallback still hard-blocks when neither the color nor style bucket has a cost", () => {
    const imEach = { id: "skuZ", sku_code: "NOPO-GREEN-M", style_code: "NOPO", unit_cost: 0, pack_size: 1 };
    const actions = [action({ id: "a1", sku_id: "skuZ", vendor_id: "vm1" })];
    const { byVendor, skipped } = planBuyPlanPos({
      actions, vmById: vmMap(), imById: new Map([["skuZ", imEach]]), avgBySku: new Map(),
      poEachByBaseColor: new Map(), poEachByStyle: new Map(),
    });
    expect(byVendor.size).toBe(0);
    expect(skipped[0].code).toBe(SKIP_CODES.NO_COST_SIGNAL);
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
