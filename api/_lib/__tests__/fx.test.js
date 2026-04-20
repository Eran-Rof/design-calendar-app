import { describe, it, expect } from "vitest";
import { computePaymentFx, DEFAULT_FEE_PCT } from "../fx.js";

describe("computePaymentFx", () => {
  it("same-currency is a no-op with no FX row needed", () => {
    const out = computePaymentFx({ invoiceAmount: 1000, entityCurrency: "USD", vendorCurrency: "USD" });
    expect(out).toMatchObject({ from_amount: 1000, to_amount: 1000, fx_rate: 1, fx_fee_amount: 0, needs_international_row: false });
  });

  it("pay_in_vendor_currency converts and deducts fee in vendor currency", () => {
    const out = computePaymentFx({
      invoiceAmount: 1000, entityCurrency: "USD", vendorCurrency: "EUR",
      rate: 0.9, feePct: 1, fxHandling: "pay_in_vendor_currency",
    });
    expect(out.from_amount).toBe(1000);
    expect(out.to_amount).toBe(900);            // 1000 * 0.9
    expect(out.fx_fee_amount).toBe(9);           // 1% of 900
    expect(out.vendor_receives).toBe(891);      // 900 - 9
    expect(out.entity_cost).toBe(1000);
    expect(out.vendor_currency).toBe("EUR");
    expect(out.needs_international_row).toBe(true);
  });

  it("pay_in_usd_we_absorb keeps vendor whole and adds fee to entity cost", () => {
    const out = computePaymentFx({
      invoiceAmount: 1000, entityCurrency: "USD", vendorCurrency: "EUR",
      rate: 0.9, feePct: 1, fxHandling: "pay_in_usd_we_absorb",
    });
    expect(out.vendor_receives).toBe(1000);
    expect(out.fx_fee_amount).toBe(10);
    expect(out.entity_cost).toBe(1010);
    expect(out.to_amount).toBe(1000);          // no conversion on the wire
    expect(out.fx_rate).toBe(1);
    expect(out.vendor_currency).toBe("USD");   // paid in entity currency
  });

  it("pay_in_usd_vendor_absorbs pays USD minus fee to the vendor", () => {
    const out = computePaymentFx({
      invoiceAmount: 1000, entityCurrency: "USD", vendorCurrency: "EUR",
      rate: 0.9, feePct: 1, fxHandling: "pay_in_usd_vendor_absorbs",
    });
    expect(out.vendor_receives).toBe(990);
    expect(out.fx_fee_amount).toBe(10);
    expect(out.entity_cost).toBe(1000);
    expect(out.to_amount).toBe(990);
    expect(out.fx_rate).toBe(1);
  });

  it("zero invoice amount is handled without NaN", () => {
    const out = computePaymentFx({ invoiceAmount: 0, entityCurrency: "USD", vendorCurrency: "EUR", rate: 0.9, feePct: 1, fxHandling: "pay_in_vendor_currency" });
    expect(out.to_amount).toBe(0);
    expect(out.vendor_receives).toBe(0);
    expect(out.fx_fee_amount).toBe(0);
  });

  it("DEFAULT_FEE_PCT is 1% unless overridden", () => {
    expect(DEFAULT_FEE_PCT).toBe(1);
    const out = computePaymentFx({ invoiceAmount: 1000, entityCurrency: "USD", vendorCurrency: "EUR", rate: 0.9, fxHandling: "pay_in_vendor_currency" });
    // fee = 1% of 900 = 9; vendor_receives = 891
    expect(out.fx_fee_amount).toBe(9);
    expect(out.vendor_receives).toBe(891);
  });
});
