import { describe, it, expect } from "vitest";
import { shouldArchive, getArchiveDecisions } from "../syncLogic";
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

describe("getArchiveDecisions", () => {
  describe("source 1: Xoro returned PO as closed", () => {
    it("archives with freshData so status label is correct", () => {
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Closed" })];
      const decisions = getArchiveDecisions(xoro, [], null);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].freshData?.StatusName).toBe("Closed");
    });

    it("does not archive an Open PO from Xoro", () => {
      const xoro = [makePO({ PoNumber: "PO-002", StatusName: "Open" })];
      expect(getArchiveDecisions(xoro, [], null)).toHaveLength(0);
    });

    it("does not archive Partially Received", () => {
      const xoro = [makePO({ PoNumber: "PO-003", StatusName: "Partially Received" })];
      expect(getArchiveDecisions(xoro, [], null)).toHaveLength(0);
    });
  });

  describe("source 2: cached PO with closed status", () => {
    it("archives cached Closed PO not yet archived", () => {
      const decisions = getArchiveDecisions([], [makeRow("PO-004", "Closed", false)], null);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].freshData).toBeUndefined();
    });

    it("skips cached PO already archived", () => {
      expect(getArchiveDecisions([], [makeRow("PO-005", "Closed", true)], null)).toHaveLength(0);
    });

    it("skips cached Open PO", () => {
      expect(getArchiveDecisions([], [makeRow("PO-006", "Open", false)], null)).toHaveLength(0);
    });
  });

  describe("source 3: PO missing from Xoro (deleted)", () => {
    it("does NOT archive missing PO with active status (Open/Released)", () => {
      const xoro = [makePO({ PoNumber: "PO-OTHER", StatusName: "Open" })];
      const cached = [makeRow("PO-MISSING", "Open", false)];
      const statusesWithResults = new Set(["Open"]);
      const decisions = getArchiveDecisions(xoro, cached, statusesWithResults);
      expect(decisions.some(d => d.poNumber === "PO-MISSING")).toBe(false);
    });

    it("archives missing PO with terminal status (Closed/Received/Cancelled)", () => {
      const xoro: XoroPO[] = [];
      const cached = [makeRow("PO-CLOSED", "Closed", false)];
      const decisions = getArchiveDecisions(xoro, cached, new Set(["Closed"]));
      const d = decisions.find(d => d.poNumber === "PO-CLOSED");
      expect(d).toBeDefined();
      // Source 2 catches this (cached terminal status) — no lastKnownStatus since it's not source 3
    });

    it("does NOT archive missing active POs even with empty Xoro results", () => {
      const xoro: XoroPO[] = [];
      const cached = [makeRow("PO-001", "Open", false), makeRow("PO-002", "Released", false)];
      const statusesWithResults = new Set<string>();
      const decisions = getArchiveDecisions(xoro, cached, statusesWithResults);
      expect(decisions).toHaveLength(0);
    });

    it("does NOT archive missing POs when statusesWithResults is null (filtered sync)", () => {
      const xoro: XoroPO[] = [];
      const cached = [makeRow("PO-001", "Open", false)];
      expect(getArchiveDecisions(xoro, cached, null)).toHaveLength(0);
    });

    it("does not re-archive already-archived missing PO", () => {
      const cached = [makeRow("PO-OLD", "Open", true)];
      const statusesWithResults = new Set(["Open"]);
      expect(getArchiveDecisions([], cached, statusesWithResults)).toHaveLength(0);
    });

    it("does NOT archive missing PO whose last status is Partially Received", () => {
      // Xoro API may not reliably filter by "Partially Received" — 0 results could
      // be a fetch artefact, not a real deletion. Skip source-3 for partial statuses.
      const cached = [makeRow("PO-PARTIAL", "Partially Received", false)];
      expect(getArchiveDecisions([], cached, new Set())).toHaveLength(0);
    });
  });

  describe("combined scenarios", () => {
    it("handles mix of closed, missing, and active POs correctly", () => {
      const xoro = [
        makePO({ PoNumber: "PO-ACTIVE",  StatusName: "Open"   }),
        makePO({ PoNumber: "PO-CLOSED",  StatusName: "Closed" }),
      ];
      const cached = [
        makeRow("PO-ACTIVE",  "Open",     false),
        makeRow("PO-CLOSED",  "Open",     false), // stale status in DB — Xoro says Closed
        makeRow("PO-DELETED", "Open",     false), // gone from Xoro but was Open — should NOT archive
        makeRow("PO-GONE",    "Received", false), // gone from Xoro and was Received — SHOULD archive
      ];
      const statusesWithResults = new Set(["Open", "Closed"]);
      const decisions = getArchiveDecisions(xoro, cached, statusesWithResults);
      const nums = decisions.map(d => d.poNumber);
      expect(nums).not.toContain("PO-ACTIVE");
      expect(nums).toContain("PO-CLOSED");
      expect(nums).not.toContain("PO-DELETED"); // Open POs missing from Xoro are NOT archived
      expect(nums).toContain("PO-GONE"); // Terminal POs missing from Xoro ARE archived
      const closedDecision = decisions.find(d => d.poNumber === "PO-CLOSED");
      expect(closedDecision?.freshData?.StatusName).toBe("Closed");
    });

    it("returns empty when nothing needs archiving", () => {
      const xoro = [makePO({ PoNumber: "PO-001", StatusName: "Open" })];
      const cached = [makeRow("PO-001", "Open", false)];
      expect(getArchiveDecisions(xoro, cached, new Set(["Open"]))).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("handles PO with undefined PoNumber gracefully", () => {
      const xoro = [makePO({ PoNumber: undefined, StatusName: "Closed" })];
      const decisions = getArchiveDecisions(xoro, [], null);
      // Should filter out falsy poNumber
      expect(decisions.every(d => d.poNumber !== "")).toBe(true);
    });

    it("handles empty inputs — no POs and no cached rows", () => {
      expect(getArchiveDecisions([], [], null)).toHaveLength(0);
      expect(getArchiveDecisions([], [], new Set())).toHaveLength(0);
    });

    it("deduplicates when same PO appears in both Xoro and cache", () => {
      const xoro = [makePO({ PoNumber: "PO-DUP", StatusName: "Closed" })];
      const cached = [makeRow("PO-DUP", "Closed", false)];
      const decisions = getArchiveDecisions(xoro, cached, null);
      const dupDecisions = decisions.filter(d => d.poNumber === "PO-DUP");
      expect(dupDecisions).toHaveLength(1);
      // freshData should be set from Xoro (source 1 takes precedence)
      expect(dupDecisions[0].freshData).toBeDefined();
    });

    it("handles Received status correctly", () => {
      const xoro = [makePO({ PoNumber: "PO-RCV", StatusName: "Received" })];
      const decisions = getArchiveDecisions(xoro, [], null);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].poNumber).toBe("PO-RCV");
    });

    it("handles Cancelled status correctly", () => {
      const xoro = [makePO({ PoNumber: "PO-CAN", StatusName: "Cancelled" })];
      const decisions = getArchiveDecisions(xoro, [], null);
      expect(decisions).toHaveLength(1);
    });

    it("handles cached row with missing data property", () => {
      const cached = [{ po_number: "PO-BAD", data: undefined as any }];
      // Should not crash
      const decisions = getArchiveDecisions([], cached, null);
      expect(decisions).toHaveLength(0);
    });
  });
});
