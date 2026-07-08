import { describe, it, expect } from "vitest";
import { bucketMirrorDay, composeArRoutedPayload } from "../xoro-mirror/ar-routed-summary.js";

const CUST_FACT = "c-fact", CUST_CC = "c-cc", CUST_HOUSE = "c-house";
const SKU_MENS = "sku-m", SKU_BOYS = "sku-b", SKU_PT = "sku-pt", SKU_PL = "sku-pl";

function baseInputs() {
  return {
    invoices: [
      { id: "i1", invoice_number: "INV-1", customer_id: CUST_FACT, total_amount_cents: 10000 },
      { id: "i2", invoice_number: "INV-2", customer_id: CUST_CC, total_amount_cents: 5000 },
      { id: "i3", invoice_number: "ROF Ecom-3", customer_id: CUST_HOUSE, total_amount_cents: 3000 },
    ],
    linesByInvoice: new Map([
      ["i1", [
        { inventory_item_id: SKU_MENS, line_total_cents: 6000 },
        { inventory_item_id: SKU_BOYS, line_total_cents: 4000 },
      ]],
      ["i2", [{ inventory_item_id: SKU_PT, line_total_cents: 5000 }]],
      ["i3", [{ inventory_item_id: SKU_MENS, line_total_cents: 3000 }]],
    ]),
    channelByInvoice: new Map([
      ["INV-1", "ROF"], ["INV-2", "PT"], ["ROF Ecom-3", "ROF ECOM"],
    ]),
    skuDims: new Map([
      [SKU_MENS, { brandCode: "ROF", genderCode: "M", styleCode: "RYB0001" }],
      [SKU_BOYS, { brandCode: "ROF", genderCode: "B", styleCode: "RYB0002" }],
      [SKU_PT, { brandCode: "PT", genderCode: "M", styleCode: "PTX0001" }],
      [SKU_PL, { brandCode: "ROF", genderCode: "M", styleCode: "RYB0003PL" }],
    ]),
    customers: new Map([
      [CUST_FACT, { is_factored: true, payment_processor: null }],
      [CUST_CC, { is_factored: false, payment_processor: "stripe" }],
      [CUST_HOUSE, { is_factored: false, payment_processor: null }],
    ]),
  };
}

describe("bucketMirrorDay — routed daily AR aggregation", () => {
  it("routes DR by customer class and CR by revenue bucket; always balances", () => {
    const agg = bucketMirrorDay(baseInputs());
    expect(agg.total_cents).toBe(18000);
    expect(agg.dr).toEqual([
      { account_code: "1105", customer_id: CUST_CC, cents: 5000 },
      { account_code: "1107", customer_id: CUST_FACT, cents: 10000 },
      { account_code: "1108", customer_id: CUST_HOUSE, cents: 3000 },
    ]);
    // i1 wholesale: mens 6000→4005, boys 4000→4006. i2 PT wholesale 5000→4009.
    // i3 ROF ecom 3000→4011 (channel beats gender/catch-all).
    expect(agg.cr).toEqual([
      { account_code: "4005", cents: 6000 },
      { account_code: "4006", cents: 4000 },
      { account_code: "4009", cents: 5000 },
      { account_code: "4011", cents: 3000 },
    ]);
    expect(agg.dr.reduce((s, x) => s + x.cents, 0)).toBe(agg.cr.reduce((s, x) => s + x.cents, 0));
  });

  it("private-label style routes to 4012 regardless of channel", () => {
    const inp = baseInputs();
    inp.invoices = [{ id: "i9", invoice_number: "INV-9", customer_id: CUST_HOUSE, total_amount_cents: 700 }];
    inp.linesByInvoice = new Map([["i9", [{ inventory_item_id: SKU_PL, line_total_cents: 700 }]]]);
    inp.channelByInvoice = new Map([["INV-9", "ROF ECOM"]]);
    const agg = bucketMirrorDay(inp);
    expect(agg.cr).toEqual([{ account_code: "4012", cents: 700 }]);
  });

  it("remainder + SKU-less lines fall to the channel bucket so the JE balances", () => {
    const inp = baseInputs();
    inp.invoices = [{ id: "iX", invoice_number: "INV-X", customer_id: CUST_HOUSE, total_amount_cents: 10000 }];
    // Lines only cover 4000 of the 10000; one line has no SKU (2500 → channel bucket).
    inp.linesByInvoice = new Map([["iX", [
      { inventory_item_id: SKU_MENS, line_total_cents: 1500 },
      { inventory_item_id: null, line_total_cents: 2500 },
    ]]]);
    inp.channelByInvoice = new Map([["INV-X", "PT ECOM"]]);
    const agg = bucketMirrorDay(inp);
    const total = agg.cr.reduce((s, x) => s + x.cents, 0);
    expect(total).toBe(10000);
    // 1500 mens on PT ECOM channel → PT ecom 4008; SKU-less 2500 → 4008;
    // remainder 6000 → 4008 (channel-level catch).
    expect(agg.cr).toEqual([{ account_code: "4008", cents: 10000 }]);
  });

  it("unknown channel defaults to wholesale routing", () => {
    const inp = baseInputs();
    inp.invoices = [{ id: "iY", invoice_number: "INV-Y", customer_id: CUST_HOUSE, total_amount_cents: 100 }];
    inp.linesByInvoice = new Map([["iY", [{ inventory_item_id: SKU_MENS, line_total_cents: 100 }]]]);
    inp.channelByInvoice = new Map(); // no sales-history row found
    const agg = bucketMirrorDay(inp);
    expect(agg.cr).toEqual([{ account_code: "4005", cents: 100 }]);
  });

  it("zero/empty day → zero totals, no lines", () => {
    const agg = bucketMirrorDay({ invoices: [], linesByInvoice: new Map(), channelByInvoice: new Map(), skuDims: new Map(), customers: new Map() });
    expect(agg.total_cents).toBe(0);
    expect(agg.dr).toEqual([]);
    expect(agg.cr).toEqual([]);
  });
});

describe("composeArRoutedPayload", () => {
  const ACCT = new Map([
    ["1105", "id-1105"], ["1107", "id-1107"], ["1108", "id-1108"],
    ["4005", "id-4005"], ["4006", "id-4006"], ["4009", "id-4009"], ["4011", "id-4011"],
  ]);

  it("emits control DRs with customer subledger + bucket CRs, dollars formatted", () => {
    const agg = bucketMirrorDay(baseInputs());
    const p = composeArRoutedPayload({
      entity_id: "ent", mirror_date: "2026-07-07", run_id: "run-1", agg,
      acctIdByCode: ACCT, actor_user_id: null,
    });
    expect(p.journal_type).toBe("ar_xoro_mirror_daily");
    expect(p.source_module).toBe("xoro_mirror");
    const dr = p.lines.filter((l) => l.debit !== "0");
    const cr = p.lines.filter((l) => l.credit !== "0");
    expect(dr).toHaveLength(3);
    expect(dr.every((l) => l.subledger_type === "customer" && l.subledger_id)).toBe(true);
    expect(dr.find((l) => l.account_id === "id-1107").debit).toBe("100.00");
    expect(cr.find((l) => l.account_id === "id-4006").credit).toBe("40.00");
    const drSum = dr.reduce((s, l) => s + Number(l.debit), 0);
    const crSum = cr.reduce((s, l) => s + Number(l.credit), 0);
    expect(drSum).toBeCloseTo(crSum, 2);
  });

  it("throws on a missing account code (fails the domain loudly)", () => {
    const agg = bucketMirrorDay(baseInputs());
    const partial = new Map(ACCT); partial.delete("4006");
    expect(() => composeArRoutedPayload({
      entity_id: "ent", mirror_date: "2026-07-07", run_id: "r", agg,
      acctIdByCode: partial, actor_user_id: null,
    })).toThrow(/4006/);
  });

  it("throws when unbalanced (corrupted aggregation)", () => {
    const agg = bucketMirrorDay(baseInputs());
    agg.cr[0].cents += 1;
    expect(() => composeArRoutedPayload({
      entity_id: "ent", mirror_date: "2026-07-07", run_id: "r", agg,
      acctIdByCode: ACCT, actor_user_id: null,
    })).toThrow(/unbalanced/);
  });
});
