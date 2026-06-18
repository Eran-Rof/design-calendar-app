import { describe, it, expect } from "vitest";
import { parse944 } from "../edi/builder.js";

describe("parse944 (3PL stock receipt advice)", () => {
  it("extracts po_number (N9*PO), receipt_date (W17), and W07 lines by SKU/UPC qualifier", () => {
    const segs = [
      ["W17", "20260618", "WR-12345"],          // date only; receipt # ignored for PO
      ["N9", "PO", "PO-2026-00007"],
      ["W07", "100", "EA", "012345678905", "VN", "RYB0412-BLACK-30"],
      ["W07", "50", "EA", "000000000001", "UP", "RYB0412-BLACK-32"],
      ["W07", "24", "EA", "777"],                // no qual pairs → falls back to UPC
    ];
    const r = parse944(segs);
    expect(r.po_number).toBe("PO-2026-00007");
    expect(r.receipt_date).toBe("2026-06-18");
    expect(r.lines).toEqual([
      { sku: "RYB0412-BLACK-30", qty_received: 100 },
      { sku: "RYB0412-BLACK-32", qty_received: 50 },
      { sku: "777", qty_received: 24 },
    ]);
  });

  it("takes the PO number from REF*PO and the date from G62 when W17 is absent", () => {
    const r = parse944([
      ["REF", "PO", "PO-2026-00009"],
      ["G62", "35", "20260101"],
      ["W07", "12", "EA", "888", "SK", "ABC-RED-M"],
    ]);
    expect(r.po_number).toBe("PO-2026-00009");
    expect(r.receipt_date).toBe("2026-01-01");
    expect(r.lines).toEqual([{ sku: "ABC-RED-M", qty_received: 12 }]);
  });

  it("returns null PO + empty lines for an unrelated envelope", () => {
    const r = parse944([["W06", "ORDER1"], ["SE", "5", "0001"]]);
    expect(r.po_number).toBeNull();
    expect(r.lines).toEqual([]);
  });
});
