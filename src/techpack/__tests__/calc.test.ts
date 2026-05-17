// Tests for the pure costing/BOM/approval math extracted from
// TechPack.tsx. These pin the formulas + rounding rules so future
// silent renders catch any regression.

import { describe, it, expect } from "vitest";
import {
  recomputeCosting,
  marginTierColor,
  recomputeBomItemTotal,
  bomTotal,
  isApprovalStageUnlocked,
} from "../calc";
import type { Costing, BOMItem, Approval } from "../types";

function costing(over: Partial<Costing> = {}): Costing {
  return {
    fob: 0, dutyRate: 0, duty: 0, freight: 0, insurance: 0, otherCosts: 0,
    landedCost: 0, wholesalePrice: 0, retailPrice: 0, margin: 0, notes: "",
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("recomputeCosting", () => {
  it("computes duty from fob * dutyRate / 100", () => {
    const out = recomputeCosting(costing(), { fob: 100, dutyRate: 12 });
    expect(out.duty).toBe(12);
  });

  it("rounds duty to 2 decimals", () => {
    // 100 * 12.345 / 100 = 12.345 → 12.35
    const out = recomputeCosting(costing(), { fob: 100, dutyRate: 12.345 });
    expect(out.duty).toBe(12.35);
  });

  it("landedCost = fob + duty + freight + insurance + otherCosts", () => {
    const out = recomputeCosting(costing(), {
      fob: 100, dutyRate: 10, freight: 5, insurance: 2, otherCosts: 3,
    });
    // duty = 10, landed = 100 + 10 + 5 + 2 + 3 = 120
    expect(out.landedCost).toBe(120);
  });

  it("margin = (retail - landed) / retail * 100 with 2-decimal rounding", () => {
    const out = recomputeCosting(costing(), {
      fob: 100, dutyRate: 0, retailPrice: 200,
    });
    // landed = 100, margin = (200 - 100) / 200 * 100 = 50.00
    expect(out.margin).toBe(50);
  });

  it("margin is 0 when retailPrice is 0 (no NaN)", () => {
    const out = recomputeCosting(costing(), { fob: 50, retailPrice: 0 });
    expect(out.margin).toBe(0);
  });

  it("preserves unrelated fields like notes + wholesalePrice", () => {
    const out = recomputeCosting(costing({ notes: "Q3 ask", wholesalePrice: 75 }), { fob: 50 });
    expect(out.notes).toBe("Q3 ask");
    expect(out.wholesalePrice).toBe(75);
  });

  it("returns a fresh object — does not mutate input", () => {
    const c = costing({ fob: 10, dutyRate: 10 });
    const before = { ...c };
    recomputeCosting(c, { freight: 5 });
    expect(c).toEqual(before);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("marginTierColor", () => {
  it("green at >= 50%", () => {
    expect(marginTierColor(50)).toBe("#10B981");
    expect(marginTierColor(75.4)).toBe("#10B981");
  });

  it("amber in [30, 50)", () => {
    expect(marginTierColor(30)).toBe("#F59E0B");
    expect(marginTierColor(49.99)).toBe("#F59E0B");
  });

  it("red below 30%", () => {
    expect(marginTierColor(0)).toBe("#EF4444");
    expect(marginTierColor(29.99)).toBe("#EF4444");
    expect(marginTierColor(-5)).toBe("#EF4444"); // negative margin → still red
  });
});

// ────────────────────────────────────────────────────────────────────────

function bom(over: Partial<BOMItem> = {}): BOMItem {
  return {
    id: "x", materialNo: "", material: "", placement: "", content: "",
    weight: "", quantity: "", uom: "YDS", supplier: "", unitCost: 0,
    totalCost: 0, notes: "", image: null,
    ...over,
  };
}

describe("recomputeBomItemTotal", () => {
  it("recomputes totalCost when quantity changes", () => {
    const out = recomputeBomItemTotal(bom({ unitCost: 2.5 }), { quantity: "4" });
    expect(out.totalCost).toBe(10);
  });

  it("recomputes totalCost when unitCost changes", () => {
    const out = recomputeBomItemTotal(bom({ quantity: "3" }), { unitCost: 1.99 });
    expect(out.totalCost).toBe(5.97);
  });

  it("leaves totalCost alone when only an unrelated field changes", () => {
    const out = recomputeBomItemTotal(bom({ totalCost: 42, quantity: "5", unitCost: 1 }), { notes: "blue" });
    expect(out.totalCost).toBe(42);
  });

  it("treats empty quantity as 0", () => {
    const out = recomputeBomItemTotal(bom({ unitCost: 5 }), { quantity: "" });
    expect(out.totalCost).toBe(0);
  });

  it("rounds totalCost to 2 decimals", () => {
    // 3.333 * 3 = 9.999 → 10
    const out = recomputeBomItemTotal(bom({ unitCost: 3.333 }), { quantity: "3" });
    expect(out.totalCost).toBe(10);
  });
});

describe("bomTotal", () => {
  it("sums totalCost across all items", () => {
    expect(bomTotal([bom({ totalCost: 1.5 }), bom({ totalCost: 2.25 }), bom({ totalCost: 0 })])).toBe(3.75);
  });

  it("is 0 for an empty BOM", () => {
    expect(bomTotal([])).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────

function appr(status: Approval["status"]): Approval {
  return { id: "x", stage: "Stage", status, approver: "", date: null, comments: "" };
}

describe("isApprovalStageUnlocked", () => {
  it("stage 0 is always unlocked", () => {
    expect(isApprovalStageUnlocked([], 0)).toBe(true);
    expect(isApprovalStageUnlocked([appr("Pending")], 0)).toBe(true);
  });

  it("later stage unlocked only when ALL preceding are Approved", () => {
    const a = [appr("Approved"), appr("Approved"), appr("Pending")];
    expect(isApprovalStageUnlocked(a, 1)).toBe(true);
    expect(isApprovalStageUnlocked(a, 2)).toBe(true);
  });

  it("later stage locked when a preceding stage is not Approved", () => {
    const a = [appr("Approved"), appr("Pending"), appr("Pending")];
    expect(isApprovalStageUnlocked(a, 1)).toBe(true);  // only stage 0 to check, approved
    expect(isApprovalStageUnlocked(a, 2)).toBe(false); // stage 1 is Pending
  });

  it("Rejected counts as not-Approved → blocks downstream", () => {
    const a = [appr("Approved"), appr("Rejected")];
    expect(isApprovalStageUnlocked(a, 2)).toBe(false);
  });
});
