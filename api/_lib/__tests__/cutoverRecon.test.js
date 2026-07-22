// Tests for the pure Cutover Reconciliation helpers (api/_lib/cutoverRecon.js).
// Covers: per-row variance classification, tally, PASS/FAIL threshold decision,
// deterministic capping, and the finalizeSection SQL-jsonb wrapper.

import { describe, it, expect } from "vitest";
import {
  KIND,
  STATUS,
  classifyRow,
  tallyKinds,
  decideStatus,
  capVariances,
  buildSection,
  finalizeSection,
} from "../cutoverRecon.js";

describe("classifyRow", () => {
  it("native present, mirror absent -> missing_in_mirror", () => {
    expect(classifyRow({ native_present: true, mirror_present: false, native_value: 5, mirror_value: 0 }))
      .toBe(KIND.MISSING_IN_MIRROR);
  });
  it("mirror present, native absent -> missing_in_native", () => {
    expect(classifyRow({ native_present: false, mirror_present: true, native_value: 0, mirror_value: 5 }))
      .toBe(KIND.MISSING_IN_NATIVE);
  });
  it("both present, values equal -> match", () => {
    expect(classifyRow({ native_present: true, mirror_present: true, native_value: 10, mirror_value: 10 }))
      .toBe(KIND.MATCH);
  });
  it("both present, values differ beyond tolerance -> value_mismatch", () => {
    expect(classifyRow({ native_present: true, mirror_present: true, native_value: 10, mirror_value: 8 }))
      .toBe(KIND.VALUE_MISMATCH);
  });
  it("value diff within tolerance -> match (absorbs cents jitter)", () => {
    expect(classifyRow(
      { native_present: true, mirror_present: true, native_value: 1000, mirror_value: 1050 },
      { tolerance: 100 },
    )).toBe(KIND.MATCH);
  });
  it("compareStatus flags unequal status before value", () => {
    expect(classifyRow(
      { native_present: true, mirror_present: true, native_value: 10, mirror_value: 10, native_status: "open", mirror_status: "closed" },
      { compareStatus: true },
    )).toBe(KIND.STATUS_MISMATCH);
  });
  it("accepts postgres bool text 't'/'f' for presence", () => {
    expect(classifyRow({ native_present: "t", mirror_present: "f", native_value: 3, mirror_value: 0 }))
      .toBe(KIND.MISSING_IN_MIRROR);
  });
  it("treats null/undefined/'' values as 0", () => {
    expect(classifyRow({ native_present: true, mirror_present: true, native_value: null, mirror_value: undefined }))
      .toBe(KIND.MATCH);
  });
});

describe("tallyKinds", () => {
  it("counts each kind and total variances (non-match)", () => {
    const classified = [
      { kind: KIND.MATCH },
      { kind: KIND.MATCH },
      { kind: KIND.MISSING_IN_MIRROR },
      { kind: KIND.MISSING_IN_NATIVE },
      { kind: KIND.VALUE_MISMATCH },
      { kind: KIND.STATUS_MISMATCH },
    ];
    const c = tallyKinds(classified);
    expect(c.total).toBe(6);
    expect(c.match).toBe(2);
    expect(c.variances).toBe(4);
    expect(c.missing_in_mirror).toBe(1);
    expect(c.status_mismatch).toBe(1);
  });
});

describe("decideStatus", () => {
  it("zero variances -> pass", () => expect(decideStatus(0)).toBe(STATUS.PASS));
  it("any variance -> fail (default threshold 0)", () => expect(decideStatus(1)).toBe(STATUS.FAIL));
  it("within threshold -> pass", () => expect(decideStatus(3, { threshold: 5 })).toBe(STATUS.PASS));
  it("beyond threshold -> fail", () => expect(decideStatus(6, { threshold: 5 })).toBe(STATUS.FAIL));
});

describe("capVariances", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    key: `K${String(i).padStart(3, "0")}`, native_value: i, mirror_value: 0,
  }));
  it("caps to N and reports true total + truncated flag", () => {
    const { shown, total, truncated } = capVariances(rows, 200);
    expect(shown.length).toBe(200);
    expect(total).toBe(250);
    expect(truncated).toBe(true);
  });
  it("no truncation when under cap", () => {
    const { shown, total, truncated } = capVariances(rows.slice(0, 10), 200);
    expect(shown.length).toBe(10);
    expect(total).toBe(10);
    expect(truncated).toBe(false);
  });
  it("sorts by descending absolute gap (biggest gaps first)", () => {
    const { shown } = capVariances(rows, 3);
    expect(shown.map((r) => r.key)).toEqual(["K249", "K248", "K247"]);
  });
  it("cap<=0 returns all rows sorted, untruncated", () => {
    const { shown, truncated } = capVariances(rows, 0);
    expect(shown.length).toBe(250);
    expect(truncated).toBe(false);
  });
});

describe("buildSection", () => {
  const rows = [
    { key: "A", native_present: true, mirror_present: true, native_value: 5, mirror_value: 5 },   // match
    { key: "B", native_present: true, mirror_present: false, native_value: 9, mirror_value: 0 },  // missing_in_mirror
    { key: "C", native_present: true, mirror_present: true, native_value: 10, mirror_value: 2 },  // value_mismatch
  ];
  it("classifies, drops matches from variances, decides FAIL, headline carries count", () => {
    const s = buildSection({ domain: "d", label: "D", rows });
    expect(s.status).toBe(STATUS.FAIL);
    expect(s.variance_total).toBe(2);
    expect(s.variances.every((v) => v.kind !== KIND.MATCH)).toBe(true);
    expect(s.headline_metrics.variance_count).toBe(2);
  });
  it("all-match -> PASS with empty variance list", () => {
    const s = buildSection({ domain: "d", label: "D", rows: [rows[0]] });
    expect(s.status).toBe(STATUS.PASS);
    expect(s.variances).toHaveLength(0);
  });
  it("unavailable short-circuits to UNAVAILABLE", () => {
    const s = buildSection({ domain: "d", label: "D", rows, unavailable: true, note: "no mirror" });
    expect(s.status).toBe(STATUS.UNAVAILABLE);
    expect(s.note).toBe("no mirror");
    expect(s.variances).toHaveLength(0);
  });
});

describe("finalizeSection (SQL-jsonb wrapper)", () => {
  const raw = {
    headline: { native_open_count: 100, status_break_count: 8 },
    variances: [
      { key: "SO1", native_present: true, mirror_present: false, native_value: 12, mirror_value: 0 },
      { key: "SO2", native_present: false, mirror_present: true, native_value: 0, mirror_value: 4 },
    ],
    variance_total: 8,
    note: null,
  };
  it("uses full-set status_break_count for PASS/FAIL, not the capped sample size", () => {
    const s = finalizeSection(raw, { domain: "sales_orders", label: "Sales Orders" });
    expect(s.status).toBe(STATUS.FAIL);
    expect(s.variance_total).toBe(8);
    expect(s.truncated).toBe(true); // 8 total > 2 shown
  });
  it("tags each returned row with its kind", () => {
    const s = finalizeSection(raw, { domain: "sales_orders", label: "Sales Orders" });
    expect(s.variances[0].kind).toBe(KIND.MISSING_IN_MIRROR);
    expect(s.variances[1].kind).toBe(KIND.MISSING_IN_NATIVE);
  });
  it("break count 0 -> PASS", () => {
    const s = finalizeSection({ headline: { status_break_count: 0 }, variances: [], variance_total: 0 }, { domain: "d", label: "D" });
    expect(s.status).toBe(STATUS.PASS);
  });
  it("unavailable flag forces UNAVAILABLE regardless of counts", () => {
    const s = finalizeSection(raw, { domain: "d", label: "D", unavailable: true });
    expect(s.status).toBe(STATUS.UNAVAILABLE);
  });
  it("AP-style cents tolerance keeps small $ diffs as match kind", () => {
    const apRaw = {
      headline: { status_break_count: 1 },
      variances: [
        { key: "B1", native_present: true, mirror_present: true, native_value: 100000, mirror_value: 100050 }, // within 100c
        { key: "B2", native_present: true, mirror_present: false, native_value: 500000, mirror_value: null },  // missing
      ],
      variance_total: 1,
    };
    const s = finalizeSection(apRaw, { domain: "ap", label: "Accounts Payable", tolerance: 100 });
    expect(s.variances.find((v) => v.key === "B1").kind).toBe(KIND.MATCH);
    expect(s.variances.find((v) => v.key === "B2").kind).toBe(KIND.MISSING_IN_MIRROR);
  });
  it("defensive against missing fields", () => {
    const s = finalizeSection({}, { domain: "d", label: "D" });
    expect(s.status).toBe(STATUS.PASS);
    expect(s.variances).toEqual([]);
    expect(s.variance_total).toBe(0);
  });
});
