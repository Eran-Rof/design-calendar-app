import { describe, it, expect } from "vitest";
import { shouldArchive, getPOsToArchive } from "../syncLogic";
import type { XoroPO } from "../../utils/tandaTypes";

function makePO(overrides: Partial<XoroPO> = {}): XoroPO {
  return { PoNumber: "PO-001", StatusName: "Open", VendorName: "Vendor A", ...overrides } as XoroPO;
}

function makeRow(po_number: string, status: string, archived = false) {
  return {
    po_number,
    data: makePO({ PoNumber: po_number, StatusName: status, _archived: archived }),
  };
}

describe("shouldArchive", () => {
  it.each(["Closed", "Received", "Cancelled"])("returns true for %s", (status) => {
    expect(shouldArchive(status)).toBe(true);
  });

  it.each(["Open", "Released", "Pending", "Draft"])("returns false for %s", (status) => {
    expect(shouldArchive(status)).toBe(false);
  });

  it("returns false for Partially Received", () => {
    expect(shouldArchive("Partially Received")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldArchive("")).toBe(false);
  });
});

describe("getPOsToArchive", () => {
  describe("status-based archiving from Xoro response", () => {
    it("archives a Closed PO returned by Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Closed" })];
      expect(getPOsToArchive(xoro, []).has("PO-001")).toBe(true);
    });

    it("archives a Received PO returned by Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-002", StatusName: "Received" })];
      expect(getPOsToArchive(xoro, []).has("PO-002")).toBe(true);
    });

    it("does not archive an Open PO from Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-003", StatusName: "Open" })];
      expect(getPOsToArchive(xoro, []).has("PO-003")).toBe(false);
    });

    it("does not archive a Partially Received PO from Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-004", StatusName: "Partially Received" })];
      expect(getPOsToArchive(xoro, []).has("PO-004")).toBe(false);
    });
  });

  describe("status-based archiving from cache", () => {
    it("archives a cached PO with Closed status not yet archived", () => {
      expect(getPOsToArchive([], [makeRow("PO-005", "Closed", false)]).has("PO-005")).toBe(true);
    });

    it("skips a cached PO already marked as archived", () => {
      expect(getPOsToArchive([], [makeRow("PO-006", "Closed", true)]).has("PO-006")).toBe(false);
    });

    it("never archives an active cached PO regardless of what Xoro returned", () => {
      // Even if Xoro returned nothing (empty response), Open POs stay active
      expect(getPOsToArchive([], [makeRow("PO-007", "Open", false)]).has("PO-007")).toBe(false);
    });
  });

  describe("combined scenarios", () => {
    it("handles mix of closed and active POs correctly", () => {
      const xoro = [
        makePO({ PoNumber: "PO-ACTIVE", StatusName: "Open" }),
        makePO({ PoNumber: "PO-CLOSED", StatusName: "Closed" }),
      ];
      const cached = [
        makeRow("PO-ACTIVE",  "Open",   false),
        makeRow("PO-CLOSED",  "Closed", false),
        makeRow("PO-MISSING", "Open",   false), // not in Xoro response — stays active
      ];
      const result = getPOsToArchive(xoro, cached);
      expect(result.has("PO-ACTIVE")).toBe(false);
      expect(result.has("PO-CLOSED")).toBe(true);
      expect(result.has("PO-MISSING")).toBe(false); // NOT archived just because missing from Xoro
    });

    it("returns empty set when nothing needs archiving", () => {
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Open" })];
      const cached = [makeRow("PO-001", "Open", false)];
      expect(getPOsToArchive(xoro, cached).size).toBe(0);
    });

    it("does not archive Open POs even when Xoro returns empty results", () => {
      const cached = [
        makeRow("PO-001", "Open", false),
        makeRow("PO-002", "Open", false),
        makeRow("PO-003", "Released", false),
      ];
      // Xoro returned nothing — should NOT archive any active POs
      expect(getPOsToArchive([], cached).size).toBe(0);
    });
  });
});
