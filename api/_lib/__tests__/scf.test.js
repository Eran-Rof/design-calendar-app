import { describe, it, expect } from "vitest";
import {
  calculateFee, daysToDueDate, hasCapacity, isInvoiceEligible,
  nextStatus, planApproval, STATUSES,
} from "../scf.js";

describe("calculateFee", () => {
  it("prorates the annual base rate to the financing window", () => {
    // $10k at 6% annual for 30 days → fee_pct = 6 * 30/365 ≈ 0.493; fee ≈ $49.32
    const f = calculateFee({ amount: 10000, baseRatePct: 6, daysToDue: 30 });
    expect(f.fee_pct).toBeCloseTo(0.4932, 3);
    expect(f.fee_amount).toBeCloseTo(49.32, 1);
    expect(f.net_disbursement).toBeCloseTo(9950.68, 1);
  });
  it("is zero when days_to_due is 0 or negative", () => {
    expect(calculateFee({ amount: 1000, baseRatePct: 10, daysToDue: 0 }).fee_amount).toBe(0);
    expect(calculateFee({ amount: 1000, baseRatePct: 10, daysToDue: -5 }).fee_amount).toBe(0);
  });
  it("handles non-finite inputs safely (treated as 0)", () => {
    expect(calculateFee({ amount: NaN, baseRatePct: 6, daysToDue: 30 }).fee_amount).toBe(0);
    expect(calculateFee({ amount: 1000, baseRatePct: "bad", daysToDue: 30 }).fee_amount).toBe(0);
  });
});

describe("daysToDueDate", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  it("rounds to whole days", () => {
    expect(daysToDueDate("2026-05-19", now)).toBe(30);
  });
  it("clamps past due dates to 0", () => {
    expect(daysToDueDate("2026-04-01", now)).toBe(0);
  });
  it("returns 0 when due_date is missing", () => {
    expect(daysToDueDate(null, now)).toBe(0);
  });
});

describe("hasCapacity", () => {
  const program = { status: "active", current_utilization: 60000, max_facility_amount: 100000 };
  it("allows if requested fits remaining capacity", () => {
    expect(hasCapacity(program, 40000)).toBe(true);
    expect(hasCapacity(program, 40001)).toBe(false);
  });
  it("rejects when program is paused or terminated", () => {
    expect(hasCapacity({ ...program, status: "paused" },     10000)).toBe(false);
    expect(hasCapacity({ ...program, status: "terminated" }, 10000)).toBe(false);
  });
  it("handles missing program", () => {
    expect(hasCapacity(null, 1000)).toBe(false);
  });
});

describe("isInvoiceEligible", () => {
  it("accepts an approved invoice with no active finance request", () => {
    const r = isInvoiceEligible({ id: "inv1", status: "approved" }, [{ invoice_id: "other", status: "requested" }]);
    expect(r.ok).toBe(true);
  });
  it("rejects non-approved invoices", () => {
    expect(isInvoiceEligible({ id: "inv1", status: "submitted" }, []).ok).toBe(false);
    expect(isInvoiceEligible({ id: "inv1", status: "paid" }, []).ok).toBe(false);
  });
  it("rejects when a non-rejected request already exists for this invoice", () => {
    expect(isInvoiceEligible({ id: "inv1", status: "approved" }, [{ invoice_id: "inv1", status: "requested" }]).reason).toBe("already_financed");
    expect(isInvoiceEligible({ id: "inv1", status: "approved" }, [{ invoice_id: "inv1", status: "funded"    }]).reason).toBe("already_financed");
  });
  it("allows if prior request was rejected", () => {
    expect(isInvoiceEligible({ id: "inv1", status: "approved" }, [{ invoice_id: "inv1", status: "rejected" }]).ok).toBe(true);
  });
});

describe("nextStatus", () => {
  it("follows the documented lifecycle", () => {
    expect(nextStatus("requested", "approved")).toBe("approved");
    expect(nextStatus("requested", "rejected")).toBe("rejected");
    expect(nextStatus("approved",  "funded")).toBe("funded");
    expect(nextStatus("approved",  "rejected")).toBe("rejected");
    expect(nextStatus("funded",    "repaid")).toBe("repaid");
  });
  it("rejects skip-state transitions", () => {
    expect(() => nextStatus("requested", "funded")).toThrow();
    expect(() => nextStatus("requested", "repaid")).toThrow();
    expect(() => nextStatus("funded",    "approved")).toThrow();
  });
  it("rejects mutation of terminal states", () => {
    expect(() => nextStatus("repaid",   "approved")).toThrow();
    expect(() => nextStatus("rejected", "approved")).toThrow();
  });
});

describe("planApproval", () => {
  const now = new Date("2026-04-19T00:00:00Z");
  const program = { id: "p1", status: "active", base_rate_pct: 6, max_facility_amount: 100000, current_utilization: 0 };
  const request = { id: "r1", requested_amount: 10000, invoice_id: "inv1" };
  const invoice = { id: "inv1", due_date: "2026-05-19" }; // 30 days

  it("computes approved_amount + fee using base rate by default", () => {
    const { patch } = planApproval({ program, request, invoice, approved_amount: 10000, now });
    expect(patch.approved_amount).toBe(10000);
    expect(patch.fee_pct).toBeCloseTo(0.4932, 3);
    expect(patch.net_disbursement).toBeCloseTo(9950.68, 1);
    expect(patch.status).toBe("approved");
    expect(patch.repayment_due_date).toBe("2026-05-19");
  });
  it("clamps approved_amount to requested_amount", () => {
    const { patch } = planApproval({ program, request, invoice, approved_amount: 99999, now });
    expect(patch.approved_amount).toBe(10000);
  });
  it("honors fee_pct_override and bypasses the base-rate calc", () => {
    const { patch } = planApproval({ program, request, invoice, approved_amount: 10000, fee_pct_override: 1.5, now });
    expect(patch.fee_pct).toBeCloseTo(1.5, 3);
    expect(patch.fee_amount).toBeCloseTo(150, 2);
    expect(patch.net_disbursement).toBeCloseTo(9850, 2);
  });
});

describe("STATUSES", () => {
  it("documents the full vocabulary", () => {
    expect(STATUSES).toEqual(["requested", "approved", "funded", "repaid", "rejected"]);
  });
});
