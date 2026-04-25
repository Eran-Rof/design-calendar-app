import { describe, it, expect } from "vitest";
import {
  buildBomLines,
  determineBomStatus,
  checkUpcCoverage,
  type BomLine,
  type BomIssueInput,
} from "../services/bomBuilderService";
import type { ScaleSizeRatio, UpcItem } from "../types";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PACK_GTIN = "10310927000001";
const STYLE     = "100227091BK";
const COLOR     = "DRESS BLUES";
const SCALE_CD  = "CD";

function makeRatio(size: string, qty: number, scale_code = SCALE_CD): ScaleSizeRatio {
  return { id: `r-${size}`, scale_code, size, qty, created_at: "" };
}

function makeUpc(size: string, upc?: string, style = STYLE, color = COLOR): UpcItem {
  return {
    id: `u-${size}`,
    upc: upc ?? `0731109800${size.padStart(2, "0")}`,
    style_no: style, color, size,
    description: null, source_method: "manual",
    created_at: "", updated_at: "",
  };
}

// Scale CD: S=0 (skip), M=1, L=2, XL=1
const RATIOS_CD: ScaleSizeRatio[] = [
  makeRatio("S",  0),
  makeRatio("M",  1),
  makeRatio("L",  2),
  makeRatio("XL", 1),
];

const UPC_ALL: UpcItem[] = [
  makeUpc("M"),
  makeUpc("L"),
  makeUpc("XL"),
];

// ── buildBomLines ─────────────────────────────────────────────────────────────

describe("buildBomLines", () => {
  it("builds lines for all matching non-zero sizes", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    expect(r.lines).toHaveLength(3);
    expect(r.lines.map(l => l.size).sort()).toEqual(["L", "M", "XL"]);
  });

  it("skips size S because qty = 0", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    expect(r.lines.find(l => l.size === "S")).toBeUndefined();
  });

  it("copies qty_in_pack from scale ratio", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    expect(r.lines.find(l => l.size === "L")?.qty_in_pack).toBe(2);
  });

  it("calculates units_per_pack as sum of qty_in_pack", () => {
    // M=1, L=2, XL=1 → 4
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    expect(r.units_per_pack).toBe(4);
  });

  it("sets pack_gtin on every BomLine", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    r.lines.forEach(l => expect(l.pack_gtin).toBe(PACK_GTIN));
  });

  it("returns complete status when all non-zero sizes have UPCs", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, UPC_ALL);
    expect(r.status).toBe("complete");
    expect(r.issues.filter(i => i.severity === "error")).toHaveLength(0);
  });

  it("returns incomplete status when some sizes are missing UPCs", () => {
    const partial = [makeUpc("M")]; // L and XL missing
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, partial);
    expect(r.status).toBe("incomplete");
    expect(r.lines).toHaveLength(1);
  });

  it("reports missing_upc_for_size issue for each missing size", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, []);
    const missing = r.issues.filter(i => i.issue_type === "missing_upc_for_size");
    // S is zero-qty and skipped; M/L/XL are missing → 3 issues
    expect(missing).toHaveLength(3);
    expect(missing.every(i => i.severity === "error")).toBe(true);
  });

  it("returns error status when no scale ratios have qty > 0", () => {
    const zeroRatios = [makeRatio("S", 0), makeRatio("M", 0)];
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, zeroRatios, UPC_ALL);
    expect(r.status).toBe("error");
    expect(r.lines).toHaveLength(0);
  });

  it("returns error status with missing_scale_ratio issue when ratios array is empty", () => {
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, [], UPC_ALL);
    expect(r.status).toBe("error");
    expect(r.units_per_pack).toBe(0);
    expect(r.issues[0]?.issue_type).toBe("missing_scale_ratio");
  });

  it("does not match UPC from wrong style", () => {
    const wrongStyle = makeUpc("M", undefined, "WRONG", COLOR);
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, [makeRatio("M", 1)], [wrongStyle]);
    expect(r.lines.find(l => l.size === "M")).toBeUndefined();
    expect(r.issues.some(i => i.issue_type === "missing_upc_for_size")).toBe(true);
  });

  it("does not match UPC from wrong color", () => {
    const wrongColor = makeUpc("M", undefined, STYLE, "WRONG COLOR");
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, [makeRatio("M", 1)], [wrongColor]);
    expect(r.lines.find(l => l.size === "M")).toBeUndefined();
  });

  it("reports duplicate_upc_match warning when same UPC appears for two sizes", () => {
    const sharedUpc = "073110981234";
    const items: UpcItem[] = [
      makeUpc("M",  sharedUpc),
      makeUpc("L",  sharedUpc), // same UPC, different size
      makeUpc("XL"),
    ];
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, items);
    const dups = r.issues.filter(i => i.issue_type === "duplicate_upc_match");
    expect(dups.length).toBeGreaterThan(0);
    expect(dups[0].severity).toBe("warning");
  });

  it("returns complete (warnings do not make it incomplete)", () => {
    // If only warnings (no errors), status should still be complete
    const sharedUpc = "073110981234";
    const items: UpcItem[] = [
      makeUpc("M",  sharedUpc),
      makeUpc("L",  sharedUpc),
      makeUpc("XL"),
    ];
    const r = buildBomLines(PACK_GTIN, STYLE, COLOR, RATIOS_CD, items);
    expect(r.status).toBe("complete");
  });
});

// ── determineBomStatus ────────────────────────────────────────────────────────

describe("determineBomStatus", () => {
  const aLine: BomLine = { pack_gtin: PACK_GTIN, child_upc: "u1", size: "M", qty_in_pack: 1 };
  const errIssue: BomIssueInput = { pack_gtin: PACK_GTIN, issue_type: "missing_upc_for_size", severity: "error", message: "miss" };
  const warnIssue: BomIssueInput = { pack_gtin: PACK_GTIN, issue_type: "duplicate_upc_match", severity: "warning", message: "dup" };

  it("returns complete when lines exist and no error issues", () => {
    expect(determineBomStatus([aLine], [])).toBe("complete");
  });

  it("returns incomplete when lines exist but has at least one error issue", () => {
    expect(determineBomStatus([aLine], [errIssue])).toBe("incomplete");
  });

  it("returns error when lines array is empty", () => {
    expect(determineBomStatus([], [])).toBe("error");
    expect(determineBomStatus([], [errIssue])).toBe("error");
  });

  it("returns complete when only warning issues and lines are present", () => {
    expect(determineBomStatus([aLine], [warnIssue])).toBe("complete");
  });
});

// ── checkUpcCoverage ──────────────────────────────────────────────────────────

describe("checkUpcCoverage", () => {
  const ratiosML = [makeRatio("M", 1), makeRatio("L", 2)];
  const upcML    = [makeUpc("M"), makeUpc("L")];

  it("returns complete when all non-zero sizes have matching UPCs", () => {
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, ratiosML, upcML);
    expect(r.complete).toBe(true);
    expect(r.missing_sizes).toHaveLength(0);
  });

  it("returns incomplete when some sizes are missing UPCs", () => {
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, [makeRatio("M", 1), makeRatio("XL", 1)], upcML);
    expect(r.complete).toBe(false);
    expect(r.missing_sizes).toContain("XL");
  });

  it("excludes zero-qty sizes from coverage requirement", () => {
    const withZero = [makeRatio("S", 0), makeRatio("M", 1)];
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, withZero, upcML);
    // S is zero-qty → not checked; M is present → complete
    expect(r.complete).toBe(true);
    expect(r.sizes.find(s => s.size === "S")).toBeUndefined();
  });

  it("populates upc field for found sizes", () => {
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, ratiosML, upcML);
    expect(r.sizes.find(s => s.size === "M")?.found).toBe(true);
    expect(r.sizes.find(s => s.size === "M")?.upc).not.toBeNull();
  });

  it("sets upc=null and found=false for missing sizes", () => {
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, [makeRatio("XL", 1)], upcML);
    expect(r.sizes.find(s => s.size === "XL")?.found).toBe(false);
    expect(r.sizes.find(s => s.size === "XL")?.upc).toBeNull();
  });

  it("ignores UPCs from wrong style or color", () => {
    const wrongStyle = makeUpc("M", undefined, "WRONG", COLOR);
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, [makeRatio("M", 1)], [wrongStyle]);
    expect(r.complete).toBe(false);
  });

  it("returns the scale_code on the result", () => {
    const r = checkUpcCoverage(STYLE, COLOR, SCALE_CD, ratiosML, upcML);
    expect(r.scale_code).toBe(SCALE_CD);
  });
});
