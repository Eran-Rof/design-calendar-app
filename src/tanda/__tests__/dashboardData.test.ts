import { describe, it, expect, vi, beforeEach } from "vitest";
import type { XoroPO, Milestone } from "../../utils/tandaTypes";

// Mock React's useMemo to just execute the factory immediately.
// This lets us test the pure logic inside useDashboardData without needing
// a React rendering environment.
vi.mock("react", () => ({
  useMemo: (fn: () => any, _deps: any[]) => fn(),
}));

// Import after mock is set up
import { useDashboardData } from "../hooks/useDashboardData";

// ── Factories ────────────────────────────────────────────────────────────────

function makePO(overrides: Partial<XoroPO> = {}): XoroPO {
  return {
    PoNumber: "PO-001",
    VendorName: "Vendor A",
    StatusName: "Open",
    DateExpectedDelivery: "2026-12-01",
    TotalAmount: 1000,
    Items: [],
    ...overrides,
  };
}

function makeMs(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "ms_1",
    po_number: "PO-001",
    phase: "Lab Dip",
    category: "Pre-Production",
    sort_order: 0,
    days_before_ddp: 120,
    expected_date: "2026-06-01",
    actual_date: null,
    status: "Not Started",
    status_date: null,
    status_dates: null,
    notes: "",
    note_entries: null,
    variant_statuses: null,
    updated_at: "",
    updated_by: "",
    ...overrides,
  };
}

// Helpers to create dates relative to today
const TODAY = new Date();
function dateStr(daysOffset: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useDashboardData", () => {
  describe("basic aggregations", () => {
    it("returns all POs when search is empty", () => {
      const pos = [makePO({ PoNumber: "PO-1" }), makePO({ PoNumber: "PO-2" })];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.dashPOs).toHaveLength(2);
    });

    it("uses filtered POs when search is non-empty", () => {
      const pos = [makePO({ PoNumber: "PO-1" }), makePO({ PoNumber: "PO-2" })];
      const filtered = [makePO({ PoNumber: "PO-1" })];
      const result = useDashboardData({ pos, filtered, search: "PO-1", milestones: {} });
      expect(result.dashPOs).toHaveLength(1);
      expect(result.dashPOs[0].PoNumber).toBe("PO-1");
    });

    it("calculates dashTotalValue correctly", () => {
      const pos = [
        makePO({ PoNumber: "PO-1", TotalAmount: 500 }),
        makePO({ PoNumber: "PO-2", TotalAmount: 300 }),
      ];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.dashTotalValue).toBe(800);
    });

    it("returns 0 totalValue when there are no POs", () => {
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones: {} });
      expect(result.dashTotalValue).toBe(0);
    });
  });

  describe("milestone aggregation", () => {
    it("flattens all milestones from all POs", () => {
      const milestones = {
        "PO-1": [makeMs({ id: "m1", po_number: "PO-1" })],
        "PO-2": [makeMs({ id: "m2", po_number: "PO-2" }), makeMs({ id: "m3", po_number: "PO-2" })],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.allMilestonesList).toHaveLength(3);
    });

    it("returns 0% completion rate when there are no milestones", () => {
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones: {} });
      expect(result.milestoneCompletionRate).toBe(0);
      expect(result.dashMilestoneCompletionRate).toBe(0);
    });

    it("calculates completion rate correctly", () => {
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", status: "Complete" }),
          makeMs({ id: "m2", status: "In Progress" }),
          makeMs({ id: "m3", status: "Complete" }),
          makeMs({ id: "m4", status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      // 2 out of 4 = 50%
      expect(result.milestoneCompletionRate).toBe(50);
    });

    it("rounds completion rate to nearest integer", () => {
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", status: "Complete" }),
          makeMs({ id: "m2", status: "In Progress" }),
          makeMs({ id: "m3", status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      // 1 out of 3 = 33.33...% -> 33
      expect(result.milestoneCompletionRate).toBe(33);
    });
  });

  describe("overdue detection", () => {
    it("detects overdue milestones (past expected_date, not Complete/N/A)", () => {
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", expected_date: dateStr(-5), status: "In Progress" }),   // overdue
          makeMs({ id: "m2", expected_date: dateStr(-3), status: "Complete" }),       // not overdue (complete)
          makeMs({ id: "m3", expected_date: dateStr(10), status: "Not Started" }),    // not overdue (future)
          makeMs({ id: "m4", expected_date: dateStr(-1), status: "N/A" }),            // not overdue (N/A)
        ],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.overdueMilestones).toHaveLength(1);
      expect(result.overdueMilestones[0].id).toBe("m1");
    });

    it("detects milestones due this week", () => {
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", expected_date: dateStr(0), status: "In Progress" }),   // today — due this week
          makeMs({ id: "m2", expected_date: dateStr(3), status: "Not Started" }),   // 3 days — due this week
          makeMs({ id: "m3", expected_date: dateStr(7), status: "Not Started" }),   // 7 days — due this week
          makeMs({ id: "m4", expected_date: dateStr(8), status: "Not Started" }),   // 8 days — not this week
          makeMs({ id: "m5", expected_date: dateStr(2), status: "Complete" }),       // complete — excluded
        ],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.dueThisWeekMilestones).toHaveLength(3);
    });

    it("milestone with null expected_date is neither overdue nor due this week", () => {
      const milestones = {
        "PO-1": [makeMs({ id: "m1", expected_date: null, status: "Not Started" })],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.overdueMilestones).toHaveLength(0);
      expect(result.dueThisWeekMilestones).toHaveLength(0);
    });
  });

  describe("overdue POs", () => {
    it("counts POs past their expected delivery that are not Received/Closed", () => {
      const pos = [
        makePO({ PoNumber: "PO-1", DateExpectedDelivery: dateStr(-10), StatusName: "Open" }),      // overdue
        makePO({ PoNumber: "PO-2", DateExpectedDelivery: dateStr(-5), StatusName: "Received" }),    // not overdue (Received)
        makePO({ PoNumber: "PO-3", DateExpectedDelivery: dateStr(-5), StatusName: "Closed" }),      // not overdue (Closed)
        makePO({ PoNumber: "PO-4", DateExpectedDelivery: dateStr(10), StatusName: "Open" }),        // not overdue (future)
      ];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.dashOverduePOs).toBe(1);
    });

    it("counts POs due this week", () => {
      const pos = [
        makePO({ PoNumber: "PO-1", DateExpectedDelivery: dateStr(0), StatusName: "Open" }),   // today
        makePO({ PoNumber: "PO-2", DateExpectedDelivery: dateStr(5), StatusName: "Open" }),   // 5 days
        makePO({ PoNumber: "PO-3", DateExpectedDelivery: dateStr(10), StatusName: "Open" }),  // too far
      ];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.dashDueThisWeekPOs).toBe(2);
    });

    it("handles PO with undefined delivery date", () => {
      const pos = [makePO({ PoNumber: "PO-1", DateExpectedDelivery: undefined })];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.dashOverduePOs).toBe(0);
      expect(result.dashDueThisWeekPOs).toBe(0);
    });
  });

  describe("upcoming milestones", () => {
    it("returns up to 15 upcoming milestones sorted by date", () => {
      const milestones: Record<string, Milestone[]> = { "PO-1": [] };
      for (let i = 0; i < 20; i++) {
        milestones["PO-1"].push(makeMs({ id: `m${i}`, expected_date: dateStr(i + 1), status: "Not Started" }));
      }
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.upcomingMilestones).toHaveLength(15);
      // Should be sorted ascending
      for (let i = 1; i < result.upcomingMilestones.length; i++) {
        expect(result.upcomingMilestones[i].expected_date! >= result.upcomingMilestones[i - 1].expected_date!).toBe(true);
      }
    });

    it("excludes completed and N/A milestones from upcoming", () => {
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", expected_date: dateStr(1), status: "Complete" }),
          makeMs({ id: "m2", expected_date: dateStr(2), status: "N/A" }),
          makeMs({ id: "m3", expected_date: dateStr(3), status: "In Progress" }),
        ],
      };
      const result = useDashboardData({ pos: [], filtered: [], search: "", milestones });
      expect(result.upcomingMilestones).toHaveLength(1);
      expect(result.upcomingMilestones[0].id).toBe("m3");
    });
  });

  describe("dashboard-scoped milestones (with search)", () => {
    it("filters dashboard milestones to only searched POs", () => {
      const pos = [makePO({ PoNumber: "PO-1" }), makePO({ PoNumber: "PO-2" })];
      const filtered = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [makeMs({ id: "m1", po_number: "PO-1" })],
        "PO-2": [makeMs({ id: "m2", po_number: "PO-2" })],
      };
      const result = useDashboardData({ pos, filtered, search: "PO-1", milestones });
      expect(result.dashMs).toHaveLength(1);
      expect(result.dashMs[0].po_number).toBe("PO-1");
      // Global milestones still include all
      expect(result.allMilestonesList).toHaveLength(2);
    });

    it("uses all milestones for dashMs when search is empty", () => {
      const pos = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [makeMs({ id: "m1", po_number: "PO-1" })],
        "PO-2": [makeMs({ id: "m2", po_number: "PO-2" })],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.dashMs).toHaveLength(2);
    });
  });

  describe("cascade alerts", () => {
    it("generates a cascade alert when a prior category has overdue milestones", () => {
      const pos = [makePO({ PoNumber: "PO-1", VendorName: "VendorX" })];
      const milestones = {
        "PO-1": [
          // Pre-Production: overdue and not complete
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(-10), status: "In Progress" }),
          // Fabric T&A: should be blocked by Pre-Production delay
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(5), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.cascadeAlerts.length).toBeGreaterThanOrEqual(1);
      const alert = result.cascadeAlerts.find(a => a.poNum === "PO-1");
      expect(alert).toBeDefined();
      expect(alert!.delayedCat).toBe("Pre-Production");
      expect(alert!.blockedCat).toBe("Fabric T&A");
      expect(alert!.daysLate).toBeGreaterThan(0);
      expect(alert!.vendor).toBe("VendorX");
    });

    it("does not generate cascade alert when prior category is all complete", () => {
      const pos = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(-10), status: "Complete" }),
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(5), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.cascadeAlerts).toHaveLength(0);
    });

    it("does not generate cascade alert when prior category milestones are all N/A", () => {
      const pos = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(-10), status: "N/A" }),
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(5), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.cascadeAlerts).toHaveLength(0);
    });

    it("does not generate cascade alert for PO with no milestones", () => {
      const pos = [makePO({ PoNumber: "PO-1" })];
      const result = useDashboardData({ pos, filtered: [], search: "", milestones: {} });
      expect(result.cascadeAlerts).toHaveLength(0);
    });

    it("does not generate cascade alert when prior category is not overdue", () => {
      const pos = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(30), status: "In Progress" }),
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(60), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.cascadeAlerts).toHaveLength(0);
    });

    it("generates alerts for multiple POs", () => {
      const pos = [
        makePO({ PoNumber: "PO-1", VendorName: "V1" }),
        makePO({ PoNumber: "PO-2", VendorName: "V2" }),
      ];
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(-5), status: "Delayed" }),
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(5), status: "Not Started" }),
        ],
        "PO-2": [
          makeMs({ id: "m3", po_number: "PO-2", category: "Samples", phase: "Fit Sample", expected_date: dateStr(-3), status: "In Progress" }),
          makeMs({ id: "m4", po_number: "PO-2", category: "Production", phase: "Prod Start", expected_date: dateStr(10), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      expect(result.cascadeAlerts.length).toBeGreaterThanOrEqual(2);
    });

    it("cascade alert only triggers on the first delayed predecessor", () => {
      // If Pre-Production and Fabric T&A are both delayed, Production should
      // only show a cascade alert for Pre-Production (the first delayed one found)
      const pos = [makePO({ PoNumber: "PO-1" })];
      const milestones = {
        "PO-1": [
          makeMs({ id: "m1", po_number: "PO-1", category: "Pre-Production", phase: "Lab Dip", expected_date: dateStr(-10), status: "In Progress" }),
          makeMs({ id: "m2", po_number: "PO-1", category: "Fabric T&A", phase: "Raw Goods", expected_date: dateStr(-5), status: "In Progress" }),
          makeMs({ id: "m3", po_number: "PO-1", category: "Production", phase: "Prod Start", expected_date: dateStr(20), status: "Not Started" }),
        ],
      };
      const result = useDashboardData({ pos, filtered: [], search: "", milestones });
      // Production should have alert pointing to Pre-Production (idx=0), not Fabric T&A
      const prodAlert = result.cascadeAlerts.find(a => a.blockedCat === "Production");
      expect(prodAlert).toBeDefined();
      expect(prodAlert!.delayedCat).toBe("Pre-Production");
    });
  });
});
