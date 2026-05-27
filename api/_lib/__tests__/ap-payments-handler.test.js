// Tests for P3-2 ap-payments read-only ledger filter validation.

import { describe, it, expect } from "vitest";
import { validateFilters } from "../../_handlers/internal/ap-payments/index.js";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("ap-payments validateFilters", () => {
  it("accepts empty filters", () => {
    expect(validateFilters({}).error).toBeUndefined();
  });
  it("rejects non-uuid invoice_id", () => {
    expect(validateFilters({ invoice_id: "abc" }).error).toMatch(/invoice_id/);
  });
  it("accepts valid invoice_id", () => {
    expect(validateFilters({ invoice_id: UUID }).error).toBeUndefined();
  });
  it("rejects invalid method", () => {
    expect(validateFilters({ method: "venmo" }).error).toMatch(/method/);
  });
  it("accepts ach method", () => {
    expect(validateFilters({ method: "ach" }).error).toBeUndefined();
  });
  it("accepts credit_card method", () => {
    expect(validateFilters({ method: "credit_card" }).error).toBeUndefined();
  });
  it("rejects bad from date", () => {
    expect(validateFilters({ from: "2026/01/01" }).error).toMatch(/from/);
  });
  it("rejects bad to date", () => {
    expect(validateFilters({ to: "yesterday" }).error).toMatch(/to/);
  });
  it("accepts valid date window", () => {
    expect(validateFilters({ from: "2026-01-01", to: "2026-12-31" }).error).toBeUndefined();
  });
});
