// Unit tests for the M4 manufacturing build posting rules. Pure functions —
// no DB. Verifies balanced JEs, correct subledgers, consume-plan indices, and
// the parts-first / styles-last ordering that keeps the indexed drains safe.

import { describe, it, expect } from "vitest";
import { mfgBuildIssue } from "../mfgBuildIssue.js";
import { mfgServiceCapitalized } from "../mfgServiceCapitalized.js";
import { mfgBuildComplete } from "../mfgBuildComplete.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const BUILD = "22222222-2222-2222-2222-222222222222";
const WIP = "33333333-3333-3333-3333-333333333333";
const PARTS_ACCT = "44444444-4444-4444-4444-444444444444";
const STYLE_ACCT = "55555555-5555-5555-5555-555555555555";
const AP = "66666666-6666-6666-6666-666666666666";
const PART = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STYLE_ITEM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FINISHED = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VENDOR = "dddddddd-dddd-dddd-dddd-dddddddddddd";

describe("mfgBuildIssue", () => {
  const event = {
    entity_id: ENTITY,
    data: {
      build_order_id: BUILD, build_number: "BUILD-00001", posting_date: "2026-06-13", wip_account_id: WIP,
      components: [
        { component_kind: "finished_style", item_id: STYLE_ITEM, qty: 10, inventory_account_id: STYLE_ACCT },
        { component_kind: "part", part_id: PART, qty: 20, inventory_account_id: PARTS_ACCT },
      ],
    },
  };

  it("orders part pairs BEFORE style pairs (drop-safety)", () => {
    const out = mfgBuildIssue(event);
    // Lines: [WIP, parts-CR, WIP, style-CR] — parts first regardless of input order.
    expect(out.accrual.lines[1].account_id).toBe(PARTS_ACCT);
    expect(out.accrual.lines[3].account_id).toBe(STYLE_ACCT);
  });

  it("emits a partConsumePlan + consumePlan with matching indices", () => {
    const out = mfgBuildIssue(event);
    expect(out.partConsumePlan).toHaveLength(1);
    expect(out.consumePlan).toHaveLength(1);
    const pp = out.partConsumePlan[0];
    expect(pp.part_id).toBe(PART);
    expect(pp.consumer_kind).toBe("build_issue");
    expect(out.accrual.lines[pp.dr_line_ix].account_id).toBe(WIP);
    expect(out.accrual.lines[pp.cr_line_ix].account_id).toBe(PARTS_ACCT);
    const sp = out.consumePlan[0];
    expect(sp.item_id).toBe(STYLE_ITEM);
    expect(sp.consumer_kind).toBe("transfer_out");
    expect(out.accrual.lines[sp.dr_line_ix].account_id).toBe(WIP);
    expect(out.accrual.lines[sp.cr_line_ix].account_id).toBe(STYLE_ACCT);
  });

  it("puts the build_order subledger on every WIP line", () => {
    const out = mfgBuildIssue(event);
    for (const l of out.accrual.lines.filter((x) => x.account_id === WIP)) {
      expect(l.subledger_type).toBe("build_order");
      expect(l.subledger_id).toBe(BUILD);
    }
  });

  it("uses 'part' / 'item' subledgers on the inventory credit lines", () => {
    const out = mfgBuildIssue(event);
    const partCr = out.accrual.lines.find((l) => l.account_id === PARTS_ACCT);
    expect(partCr.subledger_type).toBe("part");
    expect(partCr.subledger_id).toBe(PART);
    const styleCr = out.accrual.lines.find((l) => l.account_id === STYLE_ACCT);
    expect(styleCr.subledger_type).toBe("item");
    expect(styleCr.subledger_id).toBe(STYLE_ITEM);
  });

  it("rejects a service component (services capitalize separately)", () => {
    expect(() => mfgBuildIssue({ entity_id: ENTITY, data: { ...event.data, components: [{ component_kind: "service", service_item_id: PART, qty: 1, inventory_account_id: PARTS_ACCT }] } })).toThrow();
  });
});

describe("mfgServiceCapitalized", () => {
  const event = { entity_id: ENTITY, data: { build_order_id: BUILD, component_id: PART, posting_date: "2026-06-13", wip_account_id: WIP, ap_account_id: AP, vendor_id: VENDOR, charge_cents: 12345, build_number: "BUILD-00001" } };

  it("posts a balanced DR WIP / CR AP", () => {
    const out = mfgServiceCapitalized(event);
    const lines = out.accrual.lines;
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBeCloseTo(123.45);
    expect(credit).toBeCloseTo(123.45);
    expect(lines[0].account_id).toBe(WIP);
    expect(lines[0].subledger_type).toBe("build_order");
    expect(lines[1].account_id).toBe(AP);
    expect(lines[1].subledger_type).toBe("vendor");
    expect(lines[1].subledger_id).toBe(VENDOR);
  });

  it("keys idempotency on the component id", () => {
    const out = mfgServiceCapitalized(event);
    expect(out.accrual.source_table).toBe("mfg_build_service");
    expect(out.accrual.source_id).toBe(PART);
  });

  it("rejects a non-positive charge", () => {
    expect(() => mfgServiceCapitalized({ entity_id: ENTITY, data: { ...event.data, charge_cents: 0 } })).toThrow();
  });
});

describe("mfgBuildComplete", () => {
  const event = { entity_id: ENTITY, data: { build_order_id: BUILD, finished_item_id: FINISHED, posting_date: "2026-06-13", wip_account_id: WIP, finished_inventory_account_id: STYLE_ACCT, accumulated_cost_cents: 50000, completed_qty: 10, build_number: "BUILD-00001" } };

  it("posts a balanced DR finished-inv / CR WIP for the full accumulated cost", () => {
    const out = mfgBuildComplete(event);
    const lines = out.accrual.lines;
    expect(lines[0].account_id).toBe(STYLE_ACCT);
    expect(lines[0].subledger_type).toBe("item");
    expect(lines[0].subledger_id).toBe(FINISHED);
    expect(Number(lines[0].debit)).toBeCloseTo(500);
    expect(lines[1].account_id).toBe(WIP);
    expect(lines[1].subledger_type).toBe("build_order");
    expect(Number(lines[1].credit)).toBeCloseTo(500);
  });

  it("creates one finished inventory layer at the rounded unit cost, source_kind=manufacture", () => {
    const out = mfgBuildComplete(event);
    expect(out.inventoryLayers).toHaveLength(1);
    const layer = out.inventoryLayers[0];
    expect(layer.item_id).toBe(FINISHED);
    expect(layer.qty).toBe(10);
    expect(layer.unit_cost_cents).toBe(5000); // 50000 / 10
    expect(layer.source_kind).toBe("manufacture");
  });

  it("throws when nothing has accumulated", () => {
    expect(() => mfgBuildComplete({ entity_id: ENTITY, data: { ...event.data, accumulated_cost_cents: 0 } })).toThrow();
  });

  // Phase A — per-size outputs.
  const ITEM_S = "00000000-0000-0000-0000-0000000000a1";
  const ITEM_M = "00000000-0000-0000-0000-0000000000a2";
  const matrixEvent = { entity_id: ENTITY, data: { ...event.data, outputs: [
    { item_id: ITEM_S, size: "S", qty: 3 },
    { item_id: ITEM_M, size: "M", qty: 7 },
  ] } };

  it("splits the finished-inv debit per size and balances against one WIP credit", () => {
    const out = mfgBuildComplete(matrixEvent);
    const lines = out.accrual.lines;
    expect(lines).toHaveLength(3); // 2 size debits + 1 WIP credit
    expect(lines[0].subledger_id).toBe(ITEM_S);
    expect(lines[1].subledger_id).toBe(ITEM_M);
    expect(lines[2].account_id).toBe(WIP);
    const debits = lines.filter((l) => Number(l.debit) > 0).reduce((s, l) => s + Number(l.debit), 0);
    expect(debits).toBeCloseTo(500); // sums EXACTLY to accumulated (50000c)
    expect(Number(lines[2].credit)).toBeCloseTo(500);
    // proportional: 3/10 → 150.00, last (M) absorbs remainder → 350.00
    expect(Number(lines[0].debit)).toBeCloseTo(150);
    expect(Number(lines[1].debit)).toBeCloseTo(350);
  });

  it("creates one manufacture layer per size at a uniform per-unit cost", () => {
    const out = mfgBuildComplete(matrixEvent);
    expect(out.inventoryLayers).toHaveLength(2);
    expect(out.inventoryLayers.map((l) => l.item_id)).toEqual([ITEM_S, ITEM_M]);
    expect(out.inventoryLayers.map((l) => l.qty)).toEqual([3, 7]);
    expect(out.inventoryLayers.every((l) => l.unit_cost_cents === 5000)).toBe(true); // 50000 / 10
    expect(out.inventoryLayers.every((l) => l.source_kind === "manufacture")).toBe(true);
  });
});
