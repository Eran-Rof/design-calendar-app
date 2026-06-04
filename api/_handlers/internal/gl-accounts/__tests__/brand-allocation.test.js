// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateAllocations, childAccountRows } from "../[id]/brand-allocation.js";

const B1 = "11111111-1111-1111-1111-111111111111";
const B2 = "22222222-2222-2222-2222-222222222222";

describe("validateAllocations", () => {
  it("rejects empty / non-array", () => {
    expect(validateAllocations({}).error).toMatch(/non-empty/);
    expect(validateAllocations({ allocations: [] }).error).toMatch(/non-empty/);
  });
  it("requires uuid brand_ids, unique", () => {
    expect(validateAllocations({ allocations: [{ brand_id: "x", pct: 100 }] }).error).toMatch(/uuid/);
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 50 }, { brand_id: B1, pct: 50 }] }).error).toMatch(/duplicate/);
  });
  it("pct must be 0–100 and total 100", () => {
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 150 }] }).error).toMatch(/0–100|0-100/);
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 60 }, { brand_id: B2, pct: 30 }] }).error).toMatch(/total 100/);
  });
  it("allows ≤1 default", () => {
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 50, is_default: true }, { brand_id: B2, pct: 50, is_default: true }] }).error).toMatch(/one default/);
  });
  it("accepts a valid 60/40 split + tolerates rounding", () => {
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 60, is_default: true }, { brand_id: B2, pct: 40 }] }).data)
      .toEqual([{ brand_id: B1, pct: 60, is_default: true }, { brand_id: B2, pct: 40, is_default: false }]);
    expect(validateAllocations({ allocations: [{ brand_id: B1, pct: 33.33 }, { brand_id: B2, pct: 66.67 }] }).error).toBeUndefined();
  });
});

describe("childAccountRows", () => {
  it("builds {code}-{BRAND} / '{name} — {Brand}' inheriting parent type/balance", () => {
    const parent = { id: "p1", entity_id: "e1", code: "6000", name: "Marketing", account_type: "expense", account_subtype: "opex", normal_balance: "debit" };
    const brandsById = { [B1]: { id: B1, code: "ROF", name: "Ring of Fire" }, [B2]: { id: B2, code: "PT", name: "Psycho Tuna" } };
    const rows = childAccountRows(parent, brandsById, [{ brand_id: B1, pct: 60 }, { brand_id: B2, pct: 40 }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entity_id: "e1", code: "6000-ROF", name: "Marketing — Ring of Fire",
      account_type: "expense", account_subtype: "opex", normal_balance: "debit",
      parent_account_id: "p1", brand_id: B1, is_postable: true, status: "active",
    });
    expect(rows[1].code).toBe("6000-PT");
  });
});
