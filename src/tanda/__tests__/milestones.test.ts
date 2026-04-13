import { describe, it, expect } from "vitest";
import { generateMilestones, mergeMilestones } from "../milestones";
import type { Milestone, WipTemplate } from "../../utils/tandaTypes";

const TEMPLATES: WipTemplate[] = [
  { id: "t1", phase: "Lab Dip", category: "Pre-Production", daysBeforeDDP: 120, status: "Not Started", notes: "" },
  { id: "t2", phase: "Trims",   category: "Pre-Production", daysBeforeDDP: 90,  status: "Not Started", notes: "" },
  { id: "t3", phase: "Ex Factory", category: "Shipping",    daysBeforeDDP: 0,   status: "Not Started", notes: "" },
];

function makeMs(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "ms_test",
    po_number: "PO-001",
    phase: "Lab Dip",
    category: "Pre-Production",
    sort_order: 0,
    days_before_ddp: 120,
    expected_date: "2026-04-01",
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

describe("generateMilestones", () => {
  it("returns empty array for an invalid date", () => {
    expect(generateMilestones("PO-1", "not-a-date", TEMPLATES, "")).toHaveLength(0);
  });

  it("returns empty array for an empty template list", () => {
    expect(generateMilestones("PO-1", "2026-08-01", [], "")).toHaveLength(0);
  });

  it("generates one milestone per template", () => {
    const ms = generateMilestones("PO-1", "2026-08-01", TEMPLATES, "Alice");
    expect(ms).toHaveLength(3);
  });

  it("calculates expected_date correctly from DDP", () => {
    const ms = generateMilestones("PO-1", "2026-08-01", TEMPLATES, "");
    // 120 days before Aug 1 2026 = Apr 3 2026
    expect(ms[0].expected_date).toBe("2026-04-03");
    // 90 days before Aug 1 2026 = May 3 2026
    expect(ms[1].expected_date).toBe("2026-05-03");
    // 0 days before = same day as DDP
    expect(ms[2].expected_date).toBe("2026-08-01");
  });

  it("sets po_number, phase, category, sort_order correctly", () => {
    const ms = generateMilestones("PO-XYZ", "2026-08-01", TEMPLATES, "");
    expect(ms[0].po_number).toBe("PO-XYZ");
    expect(ms[0].phase).toBe("Lab Dip");
    expect(ms[0].category).toBe("Pre-Production");
    expect(ms[0].sort_order).toBe(0);
    expect(ms[1].sort_order).toBe(1);
  });

  it("sets status to Not Started and updated_by correctly", () => {
    const ms = generateMilestones("PO-1", "2026-08-01", TEMPLATES, "Bob");
    expect(ms[0].status).toBe("Not Started");
    expect(ms[0].updated_by).toBe("Bob");
    expect(ms[0].actual_date).toBeNull();
  });

  it("assigns unique IDs to each milestone", () => {
    const ms = generateMilestones("PO-1", "2026-08-01", TEMPLATES, "");
    const ids = ms.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("mergeMilestones", () => {
  it("preserves existing milestone id and actual_date when set", () => {
    const fresh = [makeMs({ id: "new-id", actual_date: null })];
    const existing = [makeMs({ id: "old-id", actual_date: "2026-03-20", status: "Complete" })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].id).toBe("old-id");
    expect(merged[0].actual_date).toBe("2026-03-20");
    expect(merged[0].status).toBe("Complete");
  });

  it("uses fresh milestone when existing has no progress", () => {
    const fresh = [makeMs({ id: "new-id" })];
    const existing = [makeMs({ id: "old-id", actual_date: null, status: "Not Started", notes: "" })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].id).toBe("new-id");
  });

  it("preserves existing milestone when it has notes", () => {
    const fresh = [makeMs({ id: "new-id", notes: "" })];
    const existing = [makeMs({ id: "old-id", notes: "Waiting on supplier" })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].id).toBe("old-id");
    expect(merged[0].notes).toBe("Waiting on supplier");
  });

  it("preserves existing when status is not Not Started", () => {
    const fresh = [makeMs({ id: "new-id" })];
    const existing = [makeMs({ id: "old-id", status: "In Progress", actual_date: null, notes: "" })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].id).toBe("old-id");
    expect(merged[0].status).toBe("In Progress");
  });

  it("handles phases in fresh that have no existing match — uses fresh", () => {
    const fresh = [makeMs({ id: "new-id", phase: "Brand New Phase" })];
    const existing = [makeMs({ id: "old-id", phase: "Lab Dip" })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].id).toBe("new-id");
    expect(merged[0].phase).toBe("Brand New Phase");
  });

  it("processes all fresh milestones", () => {
    const fresh = [
      makeMs({ id: "f1", phase: "Lab Dip" }),
      makeMs({ id: "f2", phase: "Trims", sort_order: 1 }),
    ];
    const existing = [
      makeMs({ id: "e1", phase: "Lab Dip", actual_date: "2026-03-01" }),
    ];
    const merged = mergeMilestones(existing, fresh);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("e1");   // preserved — has actual_date
    expect(merged[1].id).toBe("f2");   // fresh — no existing for Trims
  });

  it("preserves variant_statuses and note_entries from existing", () => {
    const variantStatuses = { "VAR-1": { status: "Complete", status_date: "2026-03-01" } };
    const noteEntries = [{ text: "Test note", user: "Alice", date: "2026-03-01" }];
    const fresh = [makeMs({ id: "new-id" })];
    const existing = [makeMs({
      id: "old-id",
      status: "In Progress",
      variant_statuses: variantStatuses,
      note_entries: noteEntries,
    })];
    const merged = mergeMilestones(existing, fresh);
    expect(merged[0].variant_statuses).toEqual(variantStatuses);
    expect(merged[0].note_entries).toEqual(noteEntries);
  });

  it("uses fresh expected_date and sort_order even when preserving existing state", () => {
    const fresh = [makeMs({ id: "new-id", expected_date: "2026-05-01", sort_order: 5, days_before_ddp: 60 })];
    const existing = [makeMs({ id: "old-id", expected_date: "2026-04-01", sort_order: 0, days_before_ddp: 120, status: "Complete" })];
    const merged = mergeMilestones(existing, fresh);
    // Fresh structural fields should be used
    expect(merged[0].expected_date).toBe("2026-05-01");
    expect(merged[0].sort_order).toBe(5);
    expect(merged[0].days_before_ddp).toBe(60);
    // But old state is preserved
    expect(merged[0].id).toBe("old-id");
    expect(merged[0].status).toBe("Complete");
  });

  it("returns empty array when both existing and fresh are empty", () => {
    expect(mergeMilestones([], [])).toHaveLength(0);
  });

  it("handles multiple existing milestones with same phase — uses first match", () => {
    const fresh = [makeMs({ id: "f1", phase: "Lab Dip" })];
    const existing = [
      makeMs({ id: "e1", phase: "Lab Dip", status: "Complete" }),
      makeMs({ id: "e2", phase: "Lab Dip", status: "In Progress" }),
    ];
    const merged = mergeMilestones(existing, fresh);
    // Should match first one (e1)
    expect(merged[0].id).toBe("e1");
    expect(merged[0].status).toBe("Complete");
  });
});

describe("generateMilestones — additional edge cases", () => {
  it("handles DDP on a leap year date", () => {
    const templates = [TEMPLATES[0]]; // 120 days before
    const ms = generateMilestones("PO-1", "2028-02-29", templates, "");
    expect(ms).toHaveLength(1);
    expect(ms[0].expected_date).toBeDefined();
    // 120 days before Feb 29, 2028 = Oct 31, 2027
    expect(ms[0].expected_date).toBe("2027-10-31");
  });

  it("handles large daysBeforeDDP that crosses a year boundary", () => {
    const templates: WipTemplate[] = [
      { id: "t1", phase: "Long Lead", category: "Pre-Production", daysBeforeDDP: 365, status: "Not Started", notes: "" },
    ];
    const ms = generateMilestones("PO-1", "2026-06-15", templates, "");
    expect(ms).toHaveLength(1);
    // 365 days before Jun 15 2026 = Jun 15 2025
    expect(ms[0].expected_date).toBe("2025-06-15");
  });

  it("sets updated_at to a valid ISO timestamp", () => {
    const ms = generateMilestones("PO-1", "2026-08-01", TEMPLATES, "");
    for (const m of ms) {
      expect(new Date(m.updated_at).toISOString()).toBe(m.updated_at);
    }
  });
});
