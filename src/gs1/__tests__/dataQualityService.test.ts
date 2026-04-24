import { describe, it, expect } from "vitest";
import {
  runDataQualityChecks,
  buildExceptionGroups,
  countOpenByType,
  type DQCheckInput,
} from "../services/dataQualityService";
import type { PackGtin, UpcItem, ScaleMaster, LabelBatchLine, Carton, ReceivingSession, DataQualityIssue } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeGtin(overrides: Partial<PackGtin> = {}): PackGtin {
  return {
    id: "g1",
    style_no: "100001",
    color: "BLK",
    scale_code: "CA",
    pack_gtin: "10310927000010",
    item_reference: 1,
    units_per_pack: null,
    status: "active",
    source_method: "system_generated",
    bom_status: "complete",
    bom_last_built_at: null,
    bom_issue_summary: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeUpc(overrides: Partial<UpcItem> = {}): UpcItem {
  return {
    id: "u1",
    upc: "031092700001",
    style_no: "100001",
    color: "BLK",
    size: "S",
    description: null,
    source_method: "manual",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeScale(overrides: Partial<ScaleMaster> = {}): ScaleMaster {
  return {
    id: "s1",
    scale_code: "CA",
    description: null,
    total_units: 12,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCarton(overrides: Partial<Carton> = {}): Carton {
  return {
    id: "c1",
    sscc: "003109270000000017",
    serial_reference: 17,
    batch_id: null,
    batch_line_id: null,
    upload_id: null,
    po_number: null,
    carton_no: null,
    channel: null,
    pack_gtin: "10310927000010",
    style_no: "100001",
    color: "BLK",
    scale_code: "CA",
    carton_seq: 1,
    total_packs: null,
    total_units: null,
    status: "generated",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeLine(overrides: Partial<LabelBatchLine> = {}): LabelBatchLine {
  return {
    id: "l1",
    batch_id: "b1",
    style_no: "100001",
    color: "BLK",
    scale_code: "CA",
    pack_gtin: "10310927000010",
    label_qty: 5,
    source_sheet_name: null,
    source_channel: null,
    label_type: "pack_gtin",
    sscc_first: null,
    sscc_last: null,
    carton_count: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<ReceivingSession> = {}): ReceivingSession {
  return {
    id: "rs1",
    sscc: "003109270000000017",
    carton_id: "c1",
    status: "received",
    received_at: "2026-01-01T00:00:00Z",
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const EMPTY: DQCheckInput = {
  packGtins: [],
  upcItems: [],
  scales: [],
  batchLines: [],
  cartons: [],
  receivingSessions: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runDataQualityChecks", () => {
  it("returns empty array when all data is clean", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      packGtins: [makeGtin()],
      scales: [makeScale()],
      cartons: [makeCarton()],
    });
    expect(issues).toHaveLength(0);
  });

  it("detects incomplete BOM (missing UPCs)", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      packGtins: [makeGtin({ bom_status: "incomplete" })],
    });
    expect(issues.some(i => i.issue_type === "gtin_incomplete_bom")).toBe(true);
    expect(issues.find(i => i.issue_type === "gtin_incomplete_bom")?.severity).toBe("error");
  });

  it("detects GTIN not_built (no BOM attempt)", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      packGtins: [makeGtin({ bom_status: "not_built" })],
    });
    expect(issues.some(i => i.issue_type === "gtin_no_bom")).toBe(true);
    expect(issues.find(i => i.issue_type === "gtin_no_bom")?.severity).toBe("warning");
  });

  it("detects invalid GTIN length (not 14 digits)", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      packGtins: [makeGtin({ pack_gtin: "123" })],
    });
    expect(issues.some(i => i.issue_type === "invalid_gtin_length")).toBe(true);
    expect(issues.find(i => i.issue_type === "invalid_gtin_length")?.severity).toBe("error");
  });

  it("detects invalid SSCC length (not 18 digits)", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      cartons: [makeCarton({ sscc: "00310927SHORT" })],
    });
    expect(issues.some(i => i.issue_type === "invalid_sscc_length")).toBe(true);
    expect(issues.find(i => i.issue_type === "invalid_sscc_length")?.severity).toBe("error");
  });

  it("detects scale with zero total units", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      scales: [makeScale({ total_units: 0 })],
    });
    expect(issues.some(i => i.issue_type === "scale_zero_units")).toBe(true);
  });

  it("detects UPC duplicate conflicts", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      upcItems: [
        makeUpc({ id: "u1", upc: "031092700001" }),
        makeUpc({ id: "u2", upc: "031092700002" }),  // same style/color/size, different UPC
      ],
    });
    expect(issues.some(i => i.issue_type === "upc_duplicate")).toBe(true);
    const dup = issues.find(i => i.issue_type === "upc_duplicate")!;
    expect(dup.severity).toBe("error");
    expect((dup.context as Record<string, unknown>).upcs).toHaveLength(2);
  });

  it("does not flag distinct UPCs for different sizes", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      upcItems: [
        makeUpc({ id: "u1", upc: "031092700001", size: "S" }),
        makeUpc({ id: "u2", upc: "031092700002", size: "M" }),
      ],
    });
    expect(issues.filter(i => i.issue_type === "upc_duplicate")).toHaveLength(0);
  });

  it("detects batch line with label_qty <= 0", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      batchLines: [makeLine({ label_qty: 0 })],
    });
    expect(issues.some(i => i.issue_type === "batch_line_zero_qty")).toBe(true);
  });

  it("detects receiving variance", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      receivingSessions: [makeSession({ status: "variance" })],
    });
    expect(issues.some(i => i.issue_type === "receiving_variance")).toBe(true);
  });

  it("does not flag received sessions without variance", () => {
    const issues = runDataQualityChecks({
      ...EMPTY,
      receivingSessions: [makeSession({ status: "received" })],
    });
    expect(issues.filter(i => i.issue_type === "receiving_variance")).toHaveLength(0);
  });
});

describe("buildExceptionGroups", () => {
  function makeIssue(overrides: Partial<DataQualityIssue>): DataQualityIssue {
    return {
      id: Math.random().toString(36).slice(2),
      issue_type: "gtin_incomplete_bom",
      severity: "error",
      entity_type: "pack_gtin",
      entity_id: "10310927000010",
      message: "Test issue",
      status: "open",
      context: null,
      created_at: "2026-04-29T00:00:00Z",
      resolved_at: null,
      resolution_note: null,
      ...overrides,
    };
  }

  it("groups open issues by type and returns correct counts", () => {
    const issues = [
      makeIssue({ issue_type: "gtin_incomplete_bom", severity: "error" }),
      makeIssue({ issue_type: "gtin_incomplete_bom", severity: "error" }),
      makeIssue({ issue_type: "upc_duplicate",       severity: "error" }),
    ];
    const groups = buildExceptionGroups(issues);
    const bomGroup = groups.find(g => g.key === "gtin_incomplete_bom")!;
    expect(bomGroup.count).toBe(2);
    const upcGroup = groups.find(g => g.key === "upc_duplicate")!;
    expect(upcGroup.count).toBe(1);
  });

  it("excludes resolved issues from open group counts", () => {
    const issues = [
      makeIssue({ issue_type: "gtin_incomplete_bom", status: "open" }),
      makeIssue({ issue_type: "gtin_incomplete_bom", status: "resolved" }),
    ];
    const groups = buildExceptionGroups(issues);
    const group = groups.find(g => g.key === "gtin_incomplete_bom")!;
    expect(group.count).toBe(1);
  });

  it("sorts errors before warnings", () => {
    const issues = [
      makeIssue({ issue_type: "scale_zero_units",    severity: "warning" }),
      makeIssue({ issue_type: "gtin_incomplete_bom", severity: "error" }),
    ];
    const groups = buildExceptionGroups(issues);
    expect(groups[0].severity).toBe("error");
    expect(groups[1].severity).toBe("warning");
  });

  it("returns empty array when all issues are resolved", () => {
    const issues = [
      makeIssue({ status: "resolved" }),
    ];
    const groups = buildExceptionGroups(issues);
    expect(groups).toHaveLength(0);
  });
});

describe("countOpenByType", () => {
  it("returns correct counts for open issues only", () => {
    function makeIssue(type: string, status: "open" | "resolved"): DataQualityIssue {
      return {
        id: Math.random().toString(36).slice(2),
        issue_type: type,
        severity: "warning",
        entity_type: null,
        entity_id: null,
        message: "x",
        status,
        context: null,
        created_at: "2026-04-29T00:00:00Z",
        resolved_at: null,
        resolution_note: null,
      };
    }
    const issues = [
      makeIssue("a", "open"),
      makeIssue("a", "open"),
      makeIssue("a", "resolved"),
      makeIssue("b", "open"),
    ];
    const counts = countOpenByType(issues);
    expect(counts["a"]).toBe(2);
    expect(counts["b"]).toBe(1);
    expect(counts["c"]).toBeUndefined();
  });
});
