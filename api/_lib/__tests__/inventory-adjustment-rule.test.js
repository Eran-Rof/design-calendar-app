// Tests for Tangerine P3-5 inventoryAdjustment posting rule.
//
// The rule produces:
//   Positive qty_delta → { accrual, cash, inventoryLayers: [...] }
//   Negative qty_delta → { accrual, cash, consumePlan: [...] }
//
// The sentinel "0" debit/credit on the negative path is rewritten by postEvent
// after FIFO consume() returns cogs_cents.

import { describe, it, expect } from "vitest";
import { inventoryAdjustment } from "../accounting/posting/rules/inventoryAdjustment.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const ADJ = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const INV_ACC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const GL_ACC = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const USER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function baseEvent(extra = {}) {
  return {
    kind: "inventory_adjustment",
    entity_id: ENTITY,
    created_by_user_id: USER,
    data: {
      adjustment_id: ADJ,
      item_id: ITEM,
      adjustment_type: "shrinkage",
      qty_delta: -5,
      unit_cost_cents: null,
      inventory_account_id: INV_ACC,
      gl_account_id: GL_ACC,
      posting_date: "2026-05-27",
      reason: "test",
      ...extra,
    },
  };
}

describe("inventoryAdjustment — required fields", () => {
  it("rejects missing adjustment_id", () => {
    const e = baseEvent();
    delete e.data.adjustment_id;
    expect(() => inventoryAdjustment(e)).toThrow(/adjustment_id/);
  });
  it("rejects missing item_id", () => {
    const e = baseEvent();
    delete e.data.item_id;
    expect(() => inventoryAdjustment(e)).toThrow(/item_id/);
  });
  it("rejects missing gl_account_id", () => {
    const e = baseEvent();
    delete e.data.gl_account_id;
    expect(() => inventoryAdjustment(e)).toThrow(/gl_account_id/);
  });
  it("rejects missing inventory_account_id", () => {
    const e = baseEvent();
    delete e.data.inventory_account_id;
    expect(() => inventoryAdjustment(e)).toThrow(/inventory_account_id/);
  });
  it("rejects zero qty_delta", () => {
    expect(() => inventoryAdjustment(baseEvent({ qty_delta: 0 }))).toThrow(/cannot be zero/);
  });
  it("rejects bad adjustment_type", () => {
    expect(() => inventoryAdjustment(baseEvent({ adjustment_type: "bogus" }))).toThrow(/adjustment_type/);
  });
  it("rejects positive without unit_cost_cents", () => {
    const e = baseEvent({ qty_delta: 5, unit_cost_cents: null });
    expect(() => inventoryAdjustment(e)).toThrow(/unit_cost_cents required/);
  });
  it("rejects negative unit_cost_cents on positive", () => {
    expect(() => inventoryAdjustment(baseEvent({
      qty_delta: 5, unit_cost_cents: -100,
    }))).toThrow(/>= 0/);
  });
});

describe("inventoryAdjustment — POSITIVE qty_delta (found / correction-up)", () => {
  const result = inventoryAdjustment(baseEvent({
    adjustment_type: "found",
    qty_delta: 10,
    unit_cost_cents: 1500, // $15.00/unit
  }));

  it("produces both accrual + cash JE candidates (same lines)", () => {
    expect(result.accrual).toBeDefined();
    expect(result.cash).toBeDefined();
    expect(result.accrual.basis).toBe("ACCRUAL");
    expect(result.cash.basis).toBe("CASH");
  });
  it("DR inventory, CR counter account, amount = qty × cost", () => {
    expect(result.accrual.lines).toHaveLength(2);
    const [dr, cr] = result.accrual.lines;
    expect(dr.account_id).toBe(INV_ACC);
    expect(dr.debit).toBe("150.00");
    expect(dr.credit).toBe("0");
    expect(dr.subledger_type).toBe("item");
    expect(dr.subledger_id).toBe(ITEM);
    expect(cr.account_id).toBe(GL_ACC);
    expect(cr.debit).toBe("0");
    expect(cr.credit).toBe("150.00");
  });
  it("queues exactly one inventoryLayers entry, source_kind='adjustment'", () => {
    expect(result.inventoryLayers).toHaveLength(1);
    expect(result.inventoryLayers[0]).toMatchObject({
      item_id: ITEM,
      qty: 10,
      unit_cost_cents: 1500,
      source_kind: "adjustment",
      source_adjustment_id: ADJ,
      received_at: "2026-05-27",
    });
  });
  it("emits NO consumePlan on positive path", () => {
    expect(result.consumePlan).toBeUndefined();
  });
  it("accrual + cash get independent line arrays (no aliasing)", () => {
    expect(result.accrual.lines).not.toBe(result.cash.lines);
  });
  it("source_module = 'inventory', source_table = 'inventory_adjustments', source_id = adjustment id", () => {
    expect(result.accrual.source_module).toBe("inventory");
    expect(result.accrual.source_table).toBe("inventory_adjustments");
    expect(result.accrual.source_id).toBe(ADJ);
  });
});

describe("inventoryAdjustment — NEGATIVE qty_delta (damage / shrinkage / write_off)", () => {
  const result = inventoryAdjustment(baseEvent({
    adjustment_type: "shrinkage",
    qty_delta: -7,
    unit_cost_cents: null,
  }));

  it("produces both accrual + cash JE candidates", () => {
    expect(result.accrual).toBeDefined();
    expect(result.cash).toBeDefined();
  });
  it("emits sentinel-amount JE lines (DR counter / CR inventory, both '0')", () => {
    const [dr, cr] = result.accrual.lines;
    expect(dr.account_id).toBe(GL_ACC);
    expect(dr.debit).toBe("0");
    expect(cr.account_id).toBe(INV_ACC);
    expect(cr.credit).toBe("0");
    expect(cr.subledger_type).toBe("item");
    expect(cr.subledger_id).toBe(ITEM);
  });
  it("emits a consumePlan describing the FIFO consume", () => {
    expect(result.consumePlan).toHaveLength(1);
    expect(result.consumePlan[0]).toEqual({
      item_id: ITEM,
      qty: 7,
      consumer_kind: "adjustment_decrease",
      consumer_ref_id: ADJ,
    });
  });
  it("emits NO inventoryLayers on negative path", () => {
    expect(result.inventoryLayers).toBeUndefined();
  });
  it("description includes adjustment_type + reason", () => {
    expect(result.accrual.description).toMatch(/shrinkage/);
    expect(result.accrual.description).toMatch(/test/);
  });
});

describe("inventoryAdjustment — accepts all six adjustment_types", () => {
  it.each(["damage", "shrinkage", "found", "correction", "write_off", "return_to_vendor"])(
    "%s",
    (type) => {
      // For positive types ('found'/'correction'), pass cost; for others, negative.
      const e = baseEvent({
        adjustment_type: type,
        qty_delta: type === "found" ? 5 : -5,
        unit_cost_cents: type === "found" ? 100 : null,
      });
      expect(() => inventoryAdjustment(e)).not.toThrow();
    },
  );
});

describe("inventoryAdjustment — accrual + cash lines are equal but independent", () => {
  it("positive path: both bases get the same DR/CR shape", () => {
    const r = inventoryAdjustment(baseEvent({ qty_delta: 3, unit_cost_cents: 500, adjustment_type: "found" }));
    expect(r.accrual.lines[0].debit).toBe(r.cash.lines[0].debit);
    expect(r.accrual.lines[1].credit).toBe(r.cash.lines[1].credit);
    expect(r.accrual.lines).not.toBe(r.cash.lines); // independent arrays
  });
  it("negative path: both bases get sentinel '0' on the same line positions", () => {
    const r = inventoryAdjustment(baseEvent({ qty_delta: -3, adjustment_type: "damage" }));
    expect(r.accrual.lines[0].debit).toBe("0");
    expect(r.cash.lines[0].debit).toBe("0");
    expect(r.accrual.lines[1].credit).toBe("0");
    expect(r.cash.lines[1].credit).toBe("0");
  });
});

describe("inventoryAdjustment — JE line balance shape", () => {
  it("positive path: balanced (DR amount === CR amount)", () => {
    const r = inventoryAdjustment(baseEvent({ qty_delta: 4, unit_cost_cents: 250, adjustment_type: "found" }));
    expect(r.accrual.lines[0].debit).toBe("10.00");
    expect(r.accrual.lines[1].credit).toBe("10.00");
  });
  it("computes amounts in BigInt cents (no FP drift on awkward inputs)", () => {
    // 3 × 333 cents = 999 cents = "9.99"
    const r = inventoryAdjustment(baseEvent({ qty_delta: 3, unit_cost_cents: 333, adjustment_type: "found" }));
    expect(r.accrual.lines[0].debit).toBe("9.99");
  });
});
