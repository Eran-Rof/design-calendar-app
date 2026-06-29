import { describe, it, expect } from "vitest";
import { diffVendorFields, VENDOR_VISIBLE_FIELDS } from "../rfqLineRevision.js";

describe("diffVendorFields", () => {
  it("flags only the fields whose value changed", () => {
    const current = { target_price: 10, quantity: 100, fabric_code: "DEN12", color: "Black" };
    const next = { target_price: 9, quantity: 100, fabric_code: "DEN14" };
    expect(diffVendorFields(current, next, Object.keys(next)).sort()).toEqual(["fabric_code", "target_price"]);
  });

  it("treats numeric 5 and string '5' as equal (no false change)", () => {
    expect(diffVendorFields({ target_price: 5 }, { target_price: "5" }, ["target_price"])).toEqual([]);
    expect(diffVendorFields({ quantity: 100 }, { quantity: "100" }, ["quantity"])).toEqual([]);
  });

  it("treats '' and null as equal", () => {
    expect(diffVendorFields({ color: "" }, { color: null }, ["color"])).toEqual([]);
    expect(diffVendorFields({ fit: null }, { fit: "" }, ["fit"])).toEqual([]);
  });

  it("detects a real string change (trimmed)", () => {
    expect(diffVendorFields({ color: "Black" }, { color: "Navy" }, ["color"])).toEqual(["color"]);
    expect(diffVendorFields({ color: "Black" }, { color: " Black " }, ["color"])).toEqual([]);
  });

  it("ignores fields not present in next (leave-as-is)", () => {
    const changed = diffVendorFields({ target_price: 10, color: "Black" }, { target_price: 9 }, VENDOR_VISIBLE_FIELDS);
    expect(changed).toEqual(["target_price"]);
  });

  it("detects a real numeric change", () => {
    expect(diffVendorFields({ target_price: 10 }, { target_price: 9.5 }, ["target_price"])).toEqual(["target_price"]);
  });
});
