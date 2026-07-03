import { describe, it, expect } from "vitest";
import { lotKeyOf, NO_LOT } from "../styleMatrix.js";

describe("lotKeyOf (inventory-matrix lot filter key)", () => {
  it("passes through a real lot number, trimmed", () => {
    expect(lotKeyOf("PO-1024")).toBe("PO-1024");
    expect(lotKeyOf("  PH-2026-00001  ")).toBe("PH-2026-00001");
  });

  it("maps null / empty / whitespace-only to the NO_LOT bucket", () => {
    expect(lotKeyOf(null)).toBe(NO_LOT);
    expect(lotKeyOf(undefined)).toBe(NO_LOT);
    expect(lotKeyOf("")).toBe(NO_LOT);
    expect(lotKeyOf("   ")).toBe(NO_LOT);
  });

  it("so unlotted (opening-balance) stock all collapses to one selectable bucket", () => {
    // A style/color received before lot tracking has null lot_number on every
    // layer; they must all key to the SAME bucket so the dropdown shows it once.
    expect(lotKeyOf(null)).toBe(lotKeyOf("  "));
  });
});
