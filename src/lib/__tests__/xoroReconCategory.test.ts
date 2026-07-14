// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  categorizeReconRow,
  explainedTolerance,
  isCloseBlocking,
  CLEAN_TOLERANCE,
  type ReconComponents,
} from "../xoroReconCategory";

// Helper: a fully-explained clean row.
const row = (p: Partial<ReconComponents>): ReconComponents => ({
  variance: 0,
  residual_core: 0,
  xoro_unmirrored_debit: 0,
  reclass_net_debit: 0,
  ...p,
});

describe("categorizeReconRow", () => {
  it("exact tie is clean", () => {
    expect(categorizeReconRow(row({ variance: 0 }))).toBe("clean");
  });

  it("sub-$1 penny drift is clean (both signs, boundary inclusive)", () => {
    expect(categorizeReconRow(row({ variance: 0.99 }))).toBe("clean");
    expect(categorizeReconRow(row({ variance: -0.5 }))).toBe("clean");
    expect(categorizeReconRow(row({ variance: CLEAN_TOLERANCE }))).toBe("clean");
  });

  it("a break wholly explained by the intentional reclass → intentional_divergence", () => {
    // 4005 in a closed month: reclass moved $18,619.35 off the account; variance
    // equals the reclass, residual_core ~0.
    expect(
      categorizeReconRow(row({ variance: -18619.35, reclass_net_debit: 18619.35, residual_core: 0 })),
    ).toBe("intentional_divergence");
  });

  it("a break wholly explained by not-yet-mirrored legs → missing_txn", () => {
    // Open-month inventory: $39,093.60 of legs mirror-pending, $1.87 residual.
    expect(
      categorizeReconRow(
        row({ variance: -39093.6, xoro_unmirrored_debit: -39091.73, residual_core: -1.87 }),
      ),
    ).toBe("missing_txn");
  });

  it("missing_txn takes precedence over reclass when both present (open period)", () => {
    expect(
      categorizeReconRow(
        row({ variance: -100, xoro_unmirrored_debit: -95, reclass_net_debit: -5, residual_core: 0 }),
      ),
    ).toBe("missing_txn");
  });

  it("a >$1 residual with no reclass and no pending legs is unexplained", () => {
    // Closed-month $2.95 penny on Kids COGS — honestly surfaced, not hidden.
    expect(categorizeReconRow(row({ variance: 2.95, residual_core: 2.95 }))).toBe("unexplained");
  });

  it("a large break that does NOT reconcile after removing reclass is unexplained", () => {
    expect(
      categorizeReconRow(row({ variance: 5000, reclass_net_debit: 100, residual_core: 4900 })),
    ).toBe("unexplained");
  });

  it("relative tolerance forgives a proportionally-tiny residual on a big break", () => {
    // $195 residual on a $39K reclass break is within 0.5% → still explained.
    expect(explainedTolerance(39000)).toBeCloseTo(195, 5);
    expect(
      categorizeReconRow(row({ variance: -39000, reclass_net_debit: 39000 - 150, residual_core: -150 })),
    ).toBe("intentional_divergence");
  });
});

describe("explainedTolerance", () => {
  it("floors at $1 for small breaks and scales at 0.5% for large ones", () => {
    expect(explainedTolerance(10)).toBe(1.0);
    expect(explainedTolerance(1000)).toBe(5.0);
    expect(explainedTolerance(-1000)).toBe(5.0);
  });
});

describe("isCloseBlocking", () => {
  it("clean / intentional / excluded do not block a close; missing_txn / unmapped / unexplained do", () => {
    expect(isCloseBlocking("clean")).toBe(false);
    expect(isCloseBlocking("intentional_divergence")).toBe(false);
    expect(isCloseBlocking("excluded_by_design")).toBe(false);
    expect(isCloseBlocking("missing_txn")).toBe(true);
    expect(isCloseBlocking("unmapped")).toBe(true);
    expect(isCloseBlocking("unexplained")).toBe(true);
  });
});
