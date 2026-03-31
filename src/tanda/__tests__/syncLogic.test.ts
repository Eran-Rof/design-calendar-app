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
      const result = getPOsToArchive(xoro, [], false);
      expect(result.has("PO-001")).toBe(true);
    });

    it("archives a Received PO returned by Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-002", StatusName: "Received" })];
      expect(getPOsToArchive(xoro, [], false).has("PO-002")).toBe(true);
    });

    it("does not archive an Open PO from Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-003", StatusName: "Open" })];
      expect(getPOsToArchive(xoro, [], false).has("PO-003")).toBe(false);
    });

    it("does not archive a Partially Received PO from Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-004", StatusName: "Partially Received" })];
      expect(getPOsToArchive(xoro, [], false).has("PO-004")).toBe(false);
    });
  });

  describe("status-based archiving from cache", () => {
    it("archives a cached PO with Closed status not yet archived", () => {
      const result = getPOsToArchive([], [makeRow("PO-005", "Closed", false)], false);
      expect(result.has("PO-005")).toBe(true);
    });

    it("skips a cached PO already marked as archived", () => {
      const result = getPOsToArchive([], [makeRow("PO-006", "Closed", true)], false);
      expect(result.has("PO-006")).toBe(false);
    });

    it("skips a cached active PO on filtered sync", () => {
      const result = getPOsToArchive([], [makeRow("PO-007", "Open", false)], false);
      expect(result.has("PO-007")).toBe(false);
    });
  });

  describe("missing-from-Xoro archiving (full sync only)", () => {
    it("archives a cached active PO absent from Xoro on full sync", () => {
      const cached = [makeRow("PO-OLD", "Open", false)];
      const xoro = [makePO({ PoNumber: "PO-NEW", StatusName: "Open" })];
      const result = getPOsToArchive(xoro, cached, true);
      expect(result.has("PO-OLD")).toBe(true);
      expect(result.has("PO-NEW")).toBe(false);
    });

    it("does NOT archive missing POs on a filtered sync", () => {
      const cached = [makeRow("PO-OLD", "Open", false)];
      const xoro = [makePO({ PoNumber: "PO-NEW", StatusName: "Open" })];
      const result = getPOsToArchive(xoro, cached, false);
      expect(result.has("PO-OLD")).toBe(false);
    });

    it("does not re-archive an already-archived missing PO on full sync", () => {
      const cached = [makeRow("PO-OLD", "Open", true)];
      const result = getPOsToArchive([], cached, true);
      expect(result.has("PO-OLD")).toBe(false);
    });

    it("does not flag POs present in Xoro as missing", () => {
      const cached = [makeRow("PO-001", "Open", false)];
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Open" })];
      const result = getPOsToArchive(xoro, cached, true);
      expect(result.has("PO-001")).toBe(false);
    });
  });

  describe("combined scenarios", () => {
    it("handles mix of closed, missing, and active POs correctly", () => {
      const xoro = [
        makePO({ PoNumber: "PO-ACTIVE", StatusName: "Open" }),
        makePO({ PoNumber: "PO-CLOSED", StatusName: "Closed" }),
      ];
      const cached = [
        makeRow("PO-ACTIVE",  "Open",   false),
        makeRow("PO-CLOSED",  "Closed", false),
        makeRow("PO-DELETED", "Open",   false), // was deleted from Xoro
      ];
      const result = getPOsToArchive(xoro, cached, true);
      expect(result.has("PO-ACTIVE")).toBe(false);
      expect(result.has("PO-CLOSED")).toBe(true);
      expect(result.has("PO-DELETED")).toBe(true);
    });

    it("returns empty set when nothing needs archiving", () => {
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Open" })];
      const cached = [makeRow("PO-001", "Open", false)];
      const result = getPOsToArchive(xoro, cached, true);
      expect(result.size).toBe(0);
    });
  });
});
