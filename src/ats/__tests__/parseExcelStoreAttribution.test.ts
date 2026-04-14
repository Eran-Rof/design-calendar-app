import { describe, it, expect } from "vitest";
// Import the exported helpers from the Vercel serverless function.
// Store-attribution logic drives which inventory row an SO/PO event
// lands on; regressions here have already bitten us once (ECOM SOs
// routed to ROF rows). Lock the matrix down.
import { detectSkuStore, detectPoStore, detectSoStore } from "../../../api/parse-excel.js";

describe("detectSkuStore", () => {
  it("routes Psycho Tuna brand variants to PT", () => {
    expect(detectSkuStore("Psycho Tuna")).toBe("PT");
    expect(detectSkuStore("PSYCHO")).toBe("PT");
    expect(detectSkuStore("PTUNA")).toBe("PT");
    expect(detectSkuStore("P TUNA")).toBe("PT");
    expect(detectSkuStore("PT")).toBe("PT");
    expect(detectSkuStore("PT Something")).toBe("PT");
  });

  it("defaults everything else to ROF", () => {
    expect(detectSkuStore("Ring of Fire")).toBe("ROF");
    expect(detectSkuStore("")).toBe("ROF");
    expect(detectSkuStore(undefined)).toBe("ROF");
  });

  it("does not mis-route names that happen to contain 'PT' as a substring", () => {
    // "Impatient" — legitimately not PT
    expect(detectSkuStore("Impatient Brand")).toBe("ROF");
  });
});

describe("detectPoStore", () => {
  it("returns ROF ECOM when PO number contains ECOM", () => {
    expect(detectPoStore("ECOM-123", "Ring of Fire")).toBe("ROF ECOM");
    expect(detectPoStore("PO-ECOM-2026", "Psycho Tuna")).toBe("ROF ECOM");
  });

  it("falls back to brand detection for non-ECOM POs", () => {
    expect(detectPoStore("PO-001", "Psycho Tuna")).toBe("PT");
    expect(detectPoStore("PO-001", "Ring of Fire")).toBe("ROF");
  });

  it("prefers ECOM over brand when both apply", () => {
    // ECOM wins over PT branding — that's the physical store distinction.
    expect(detectPoStore("ECOM-PT-001", "Psycho Tuna")).toBe("ROF ECOM");
  });
});

describe("detectSoStore", () => {
  it("routes based on Sale Store column when set — fixes the 'Ring of Fire brand, PT sale store' bug", () => {
    expect(detectSoStore("SO-001", "PT", "Ring of Fire")).toBe("PT");
  });

  it("returns ROF ECOM when order number contains ECOM", () => {
    expect(detectSoStore("ECOM-SO-1", "", "Ring of Fire")).toBe("ROF ECOM");
    expect(detectSoStore("SO-2026-01", "ECOM", "Ring of Fire")).toBe("ROF ECOM");
  });

  it("falls back to brand when saleStore and orderNumber provide no signal", () => {
    expect(detectSoStore("SO-999", "", "Psycho Tuna")).toBe("PT");
    expect(detectSoStore("SO-999", "", "Ring of Fire")).toBe("ROF");
  });

  it("prefers ECOM detection over PT branding (physical store wins)", () => {
    expect(detectSoStore("ECOM-SO-9", "", "Psycho Tuna")).toBe("ROF ECOM");
  });
});
