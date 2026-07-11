import { describe, it, expect } from "vitest";
import { parseXoroAccountName, buildXoroAccountResolver, XORO_TO_ROF_CODE } from "../xoroAccountMap.js";

const ACCTS = [
  { id: "a-6348", code: "6348", name: "Logistics Warehouse Expense", is_postable: true, is_control: false, status: "active" },
  { id: "a-5402", code: "5402", name: "Freight In Expense", is_postable: true, is_control: false, status: "active" },
  { id: "a-6327", code: "6327", name: "Equipment Rental", is_postable: true, is_control: false, status: "active" },
  { id: "a-5405", code: "5405", name: "Shipping Expense", is_postable: true, is_control: false, status: "active" },
  { id: "a-2000", code: "2000", name: "Accounts Payable", is_postable: true, is_control: true, status: "active" },
  { id: "a-dead", code: "9999", name: "Dead Account", is_postable: true, is_control: false, status: "archived" },
  // deliberate duplicate name — must never resolve
  { id: "a-dup1", code: "7001", name: "Duplicate Name", is_postable: true, is_control: false, status: "active" },
  { id: "a-dup2", code: "7002", name: "Duplicate Name", is_postable: true, is_control: false, status: "active" },
];

describe("parseXoroAccountName", () => {
  it("takes the leaf of a ':' path and splits a leading code", () => {
    const p = parseXoroAccountName("5006 General and Administrative:Logistics Warehouse Expense");
    expect(p.leaf).toBe("Logistics Warehouse Expense");
    expect(p.code).toBeNull();
    expect(p.name).toBe("Logistics Warehouse Expense");
    const q = parseXoroAccountName("5005 Freight Expenses:5402 Freight In Expense");
    expect(q.code).toBe("5402");
    expect(q.name).toBe("Freight In Expense");
  });
  it("returns null for blanks", () => {
    expect(parseXoroAccountName("")).toBeNull();
    expect(parseXoroAccountName(null)).toBeNull();
  });
});

describe("buildXoroAccountResolver", () => {
  const resolve = buildXoroAccountResolver(ACCTS);

  it("resolves a Xoro path leaf to the same-named ROF account (case-insensitive)", () => {
    expect(resolve("5006 General and Administrative:Logistics Warehouse Expense").account.id).toBe("a-6348");
    expect(resolve("SHIPPING EXPENSE").account.id).toBe("a-5405");
    expect(resolve("5005 Freight Expenses:Freight In Expense").account.id).toBe("a-5402");
  });

  it("uses the curated XORO_TO_ROF_CODE map for differently-worded names", () => {
    expect(XORO_TO_ROF_CODE["rental equipment"]).toBe("6327");
    expect(resolve("Rental Equipment").account.id).toBe("a-6327");
    expect(resolve("Rental Equipment").via).toBe("map");
  });

  it("never resolves control/inactive/ambiguous targets and never fuzzy-matches", () => {
    expect(resolve("Accounts Payable")).toBeNull();   // control
    expect(resolve("Dead Account")).toBeNull();        // archived
    expect(resolve("Duplicate Name")).toBeNull();      // ambiguous
    expect(resolve("Logistics Warehouse")).toBeNull(); // partial — no fuzzy
    expect(resolve("")).toBeNull();
  });
});
