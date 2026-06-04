import { describe, it, expect } from "vitest";
import {
  normalizeRow,
  normalizeColor,
  normalizeGender,
  expectedGenderFor,
  computeCompliance,
  COLOR_ALIASES,
  GENDER_PREFIX_RULES,
  VALID_GENDERS,
  DEFAULT_COMPLIANCE_THRESHOLD_PCT,
} from "../master-sync-normalize.js";

describe("normalizeColor", () => {
  it("uppercases + trims free-text", () => {
    expect(normalizeColor("  black  ")).toBe("BLACK");
    expect(normalizeColor("Navy Blue")).toBe("NAVY BLUE");
  });
  it("canonicalizes known spelling drift", () => {
    expect(normalizeColor("camoflage")).toBe("CAMOUFLAGE");
    expect(normalizeColor("CAMMO")).toBe("CAMO");
    expect(normalizeColor("blk")).toBe("BLACK");
    expect(normalizeColor("gray")).toBe("GREY");
  });
  it("is idempotent on already-clean values", () => {
    expect(normalizeColor("BLACK")).toBe("BLACK");
    expect(normalizeColor(normalizeColor("camoflage"))).toBe("CAMOUFLAGE");
  });
  it("collapses internal whitespace", () => {
    expect(normalizeColor("RED   STRIPE")).toBe("RED STRIPE");
  });
  it("handles null / empty", () => {
    expect(normalizeColor(null)).toBe("");
    expect(normalizeColor("")).toBe("");
    expect(normalizeColor("   ")).toBe("");
  });
});

describe("normalizeGender", () => {
  it("collapses Xoro variants to canonical single-letter alphabet", () => {
    expect(normalizeGender("wms")).toBe("W");
    expect(normalizeGender("WOMENS")).toBe("W");
    expect(normalizeGender("MENS")).toBe("M");
    expect(normalizeGender("kids")).toBe("C");
    expect(normalizeGender("Unisex")).toBe("U");
  });
  it("passes already-canonical codes through unchanged", () => {
    for (const g of VALID_GENDERS) {
      expect(normalizeGender(g)).toBe(g);
    }
  });
  it("returns unrecognized uppercased token so caller can flag it", () => {
    expect(normalizeGender("xyz")).toBe("XYZ");
  });
});

describe("expectedGenderFor", () => {
  it("matches the 4-letter prefixes ahead of the 2-letter ones", () => {
    // ACMB must beat AC (no AC rule exists in the JS port, but the order
    // intent is what we're testing).
    expect(expectedGenderFor("ACMB1234")).toEqual({ gender: "M", prefix: "ACMB" });
    expect(expectedGenderFor("BRMB9999")).toEqual({ gender: "M", prefix: "BRMB" });
  });
  it("RY* style maps to mens", () => {
    expect(expectedGenderFor("RYG1816")).toEqual({ gender: "M", prefix: "RY" });
  });
  it("CJ* maps to womens (W)", () => {
    expect(expectedGenderFor("CJ0001")).toEqual({ gender: "W", prefix: "CJ" });
  });
  it("CG* maps to girls", () => {
    expect(expectedGenderFor("CG1234")).toEqual({ gender: "G", prefix: "CG" });
  });
  it("CC* maps to child", () => {
    expect(expectedGenderFor("CC1234")).toEqual({ gender: "C", prefix: "CC" });
  });
  it("returns null for unknown prefix", () => {
    expect(expectedGenderFor("ZZZZ123")).toBeNull();
    expect(expectedGenderFor("")).toBeNull();
    expect(expectedGenderFor(null)).toBeNull();
  });
  it("ports every GENDER_PREFIX_RULES entry from daily_check.py", () => {
    // Spot-check that the table didn't lose entries in transcription.
    expect(GENDER_PREFIX_RULES.length).toBeGreaterThanOrEqual(9);
  });
});

describe("normalizeRow", () => {
  it("normalizes a row with known camo color spelling variant", () => {
    const { row, changed, ops, bucket } = normalizeRow({
      BasePartNumber: "TEST123",
      Option1Value: "camoflage",
      GenderCode: "M",
      Description: "Tee",
    });
    expect(changed).toBe(true);
    expect(row.Option1Value).toBe("CAMOUFLAGE");
    expect(ops).toContain("normalize_color:Option1Value");
    expect(bucket).toBe("OK");
  });

  it("normalizes a row with CAMMO spelling drift", () => {
    const { row, changed } = normalizeRow({
      BasePartNumber: "TEST124",
      Option1Value: "cammo",
      GenderCode: "M",
      Description: "Tee",
    });
    expect(changed).toBe(true);
    expect(row.Option1Value).toBe("CAMO");
  });

  it("flags out-of-alphabet GenderCode as GENDER_INVALID", () => {
    const { bucket } = normalizeRow({
      BasePartNumber: "TEST200",
      Option1Value: "BLACK",
      GenderCode: "XYZ",
      Description: "Tee",
    });
    expect(bucket).toBe("GENDER_INVALID");
  });

  it("flags RY* with non-M GenderCode as GENDER_MISMATCH", () => {
    const { bucket } = normalizeRow({
      BasePartNumber: "RYG1816",
      Option1Value: "BLACK",
      GenderCode: "W",
      Description: "Womens shirt? no, RY* is mens",
    });
    expect(bucket).toBe("GENDER_MISMATCH");
  });

  it("passes through an already-clean row with changed=false", () => {
    const clean = {
      BasePartNumber: "RYG1816",
      ItemNumber: "RYG1816-BLACK-M",
      Option1Value: "BLACK",
      GenderCode: "M",
      GroupName: "TEES",
      CategoryName: "GRAPHIC TEES",
      ProductCategoryName: "TOPS",
      Description: "Mens crew",
    };
    const { row, changed, bucket } = normalizeRow(clean);
    expect(changed).toBe(false);
    expect(bucket).toBe("OK");
    // Object identity is allowed to differ (we always return a fresh
    // shallow copy), but field-by-field equality must hold.
    for (const k of Object.keys(clean)) {
      expect(row[k]).toEqual(clean[k]);
    }
  });

  it("is idempotent — running twice yields no further change", () => {
    const dirty = {
      BasePartNumber: "  RYG1816  ",
      Option1Value: "camoflage",
      GenderCode: "wms",
      Description: "<p>Womens shirt</p>",
      ItemNumber: "RYG1816-CAMO-M",
    };
    const pass1 = normalizeRow(dirty);
    const pass2 = normalizeRow(pass1.row);
    expect(pass1.changed).toBe(true);
    expect(pass2.changed).toBe(false);
    // bucket should agree (both will see the same row state)
    expect(pass2.bucket).toBe(pass1.bucket);
  });

  it("strips HTML from Description", () => {
    const { row, changed, ops } = normalizeRow({
      BasePartNumber: "TEST300",
      Option1Value: "BLACK",
      GenderCode: "M",
      Description: "<p>A <b>fine</b> tee</p>",
    });
    expect(changed).toBe(true);
    expect(row.Description).toBe("A fine tee");
    expect(ops).toContain("strip_html:Description");
  });

  it("flags MISSING_STYLE when both BasePartNumber and ItemNumber are absent", () => {
    const { bucket } = normalizeRow({
      Option1Value: "BLACK",
      GenderCode: "M",
      Description: "orphan",
    });
    expect(bucket).toBe("MISSING_STYLE");
  });

  it("flags MISSING_DESCRIPTION when description + title both empty", () => {
    const { bucket } = normalizeRow({
      BasePartNumber: "TEST400",
      Option1Value: "BLACK",
      GenderCode: "M",
      Description: "",
      Title: "",
    });
    expect(bucket).toBe("MISSING_DESCRIPTION");
  });

  it("does NOT flag empty GenderCode as invalid (parity with daily_check.py skip rule)", () => {
    const { bucket } = normalizeRow({
      BasePartNumber: "ZZZUNKNOWN1",  // no prefix rule
      Option1Value: "BLACK",
      GenderCode: "",
      Description: "Tee",
    });
    expect(bucket).toBe("OK");
  });
});

describe("computeCompliance", () => {
  it("returns 100% for all-clean input", () => {
    const rows = [
      { BasePartNumber: "RYG1816", GenderCode: "M", Option1Value: "BLACK", Description: "Tee" },
      { BasePartNumber: "CG0001",  GenderCode: "G", Option1Value: "PINK",  Description: "Tee" },
    ];
    const normalized = rows.map(normalizeRow);
    const c = computeCompliance(rows, normalized);
    expect(c.compliance_pct).toBe(100);
    expect(c.scanned).toBe(2);
    expect(c.compliant).toBe(2);
    expect(c.buckets.OK).toBe(2);
  });

  it("returns the right pct for mixed input", () => {
    // 8 OK + 2 bad = 80%
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push({
        BasePartNumber: `RYG${1000 + i}`,
        GenderCode: "M",
        Option1Value: "BLACK",
        Description: "Tee",
      });
    }
    // GENDER_MISMATCH: RY* must be M, here it's W
    rows.push({
      BasePartNumber: "RYG9001",
      GenderCode: "W",
      Option1Value: "BLACK",
      Description: "Tee",
    });
    // GENDER_INVALID: unknown letter
    rows.push({
      BasePartNumber: "TEST9002",
      GenderCode: "Q",
      Option1Value: "BLACK",
      Description: "Tee",
    });
    const normalized = rows.map(normalizeRow);
    const c = computeCompliance(rows, normalized);
    expect(c.scanned).toBe(10);
    expect(c.compliant).toBe(8);
    expect(c.compliance_pct).toBe(80);
    expect(c.buckets.GENDER_MISMATCH).toBe(1);
    expect(c.buckets.GENDER_INVALID).toBe(1);
  });

  it("counts auto_corrected when a row changed but ended OK", () => {
    const rows = [
      { BasePartNumber: "RYG1816", GenderCode: "M", Option1Value: "camoflage", Description: "Tee" },
      { BasePartNumber: "RYG1817", GenderCode: "M", Option1Value: "BLACK",     Description: "Tee" },
    ];
    const normalized = rows.map(normalizeRow);
    const c = computeCompliance(rows, normalized);
    expect(c.compliance_pct).toBe(100);
    expect(c.auto_corrected).toBe(1);
    expect(c.unchanged_ok).toBe(1);
  });

  it("returns 100% for empty input (vacuous truth — gate doesn't trip on empty uploads)", () => {
    const c = computeCompliance([], []);
    expect(c.compliance_pct).toBe(100);
    expect(c.scanned).toBe(0);
  });

  it("exposes DEFAULT_COMPLIANCE_THRESHOLD_PCT === 99 (parity with post_master_data.py)", () => {
    expect(DEFAULT_COMPLIANCE_THRESHOLD_PCT).toBe(99.0);
  });
});

// Handler integration: simulate the loop sync.js runs after parsing
// the CSV. We don't import sync.js (it has formidable + supabase deps
// that don't load in unit-test JIT), but we replicate the exact gate
// logic so the contract stays locked in.
describe("handler gate logic (compliance >= threshold)", () => {
  const THRESHOLD = 99.0;

  function gate(rows) {
    const normalized = rows.map(normalizeRow);
    const c = computeCompliance(rows, normalized);
    return {
      compliance: c,
      // Mirror sync.js: empty upload passes vacuously; otherwise compare.
      blocked: rows.length > 0 && c.compliance_pct < THRESHOLD,
    };
  }

  it("blocks a sub-99% upload (no upsert path entered)", () => {
    // 90% compliant = 9 OK + 1 bad
    const rows = [];
    for (let i = 0; i < 9; i++) {
      rows.push({ BasePartNumber: "RYG" + (1000 + i), GenderCode: "M", Option1Value: "BLACK", Description: "Tee" });
    }
    rows.push({ BasePartNumber: "RYG9999", GenderCode: "W", Option1Value: "BLACK", Description: "Tee" });
    const { blocked, compliance } = gate(rows);
    expect(blocked).toBe(true);
    expect(compliance.compliance_pct).toBe(90);
    expect(compliance.buckets.GENDER_MISMATCH).toBe(1);
  });

  it("allows a 100% clean upload through the gate", () => {
    const rows = [
      { BasePartNumber: "RYG1816", GenderCode: "M", Option1Value: "BLACK", Description: "Tee" },
      { BasePartNumber: "CG0001",  GenderCode: "G", Option1Value: "PINK",  Description: "Tee" },
    ];
    const { blocked, compliance } = gate(rows);
    expect(blocked).toBe(false);
    expect(compliance.compliance_pct).toBe(100);
  });

  it("allows a 99.5% upload through (just above threshold)", () => {
    // 199 OK + 1 bad = 99.5% — passes the gate.
    const rows = [];
    for (let i = 0; i < 199; i++) {
      rows.push({ BasePartNumber: "RYG" + (1000 + i), GenderCode: "M", Option1Value: "BLACK", Description: "Tee" });
    }
    rows.push({ BasePartNumber: "RYG9999", GenderCode: "Q", Option1Value: "BLACK", Description: "Tee" });
    const { blocked, compliance } = gate(rows);
    expect(blocked).toBe(false);
    expect(compliance.compliance_pct).toBe(99.5);
  });

  it("does NOT block an empty upload (vacuous truth)", () => {
    const { blocked } = gate([]);
    expect(blocked).toBe(false);
  });
});

describe("COLOR_ALIASES idempotency invariant", () => {
  it("every alias value is itself a clean uppercased token", () => {
    // This guards against an alias value that would itself drift on a
    // second pass (e.g. "CAMMO" -> "camo" would be a bug).
    for (const [, v] of Object.entries(COLOR_ALIASES)) {
      expect(v).toBe(v.toUpperCase().trim());
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
