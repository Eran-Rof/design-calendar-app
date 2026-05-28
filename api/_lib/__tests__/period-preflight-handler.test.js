// Tests for the period-close preflight handler (P5-7).
// Pure helper coverage — RPC integration tested via deploy smoke.

import { describe, it, expect } from "vitest";
import { summarize } from "../../_handlers/internal/gl-periods/preflight.js";

describe("preflight.summarize", () => {
  it("returns zero totals for empty input", () => {
    const s = summarize([]);
    expect(s).toEqual({
      total: 0,
      passed: 0,
      failed_blocking: 0,
      failed_warnings: 0,
      can_close: true,
    });
  });

  it("counts all-pass rows as can_close=true", () => {
    const s = summarize([
      { check_name: "a", status: "pass", detail: "", blocking: true },
      { check_name: "b", status: "pass", detail: "", blocking: false },
    ]);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(2);
    expect(s.can_close).toBe(true);
  });

  it("blocking fail sets can_close=false", () => {
    const s = summarize([
      { check_name: "a", status: "pass", detail: "", blocking: true },
      { check_name: "b", status: "fail", detail: "out of balance", blocking: true },
    ]);
    expect(s.failed_blocking).toBe(1);
    expect(s.can_close).toBe(false);
  });

  it("warning-only failures DO NOT block close", () => {
    const s = summarize([
      { check_name: "a", status: "pass", detail: "", blocking: true },
      { check_name: "b", status: "fail", detail: "draft AR invoice", blocking: false },
    ]);
    expect(s.failed_warnings).toBe(1);
    expect(s.failed_blocking).toBe(0);
    expect(s.can_close).toBe(true);
  });

  it("mixes counts correctly", () => {
    const s = summarize([
      { check_name: "a", status: "pass", detail: "", blocking: true },
      { check_name: "b", status: "pass", detail: "", blocking: false },
      { check_name: "c", status: "fail", detail: "x", blocking: true },
      { check_name: "d", status: "fail", detail: "y", blocking: false },
      { check_name: "e", status: "fail", detail: "z", blocking: true },
    ]);
    expect(s.total).toBe(5);
    expect(s.passed).toBe(2);
    expect(s.failed_blocking).toBe(2);
    expect(s.failed_warnings).toBe(1);
    expect(s.can_close).toBe(false);
  });
});
