// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { splitLineByAllocation, expandJeLines } from "../glAllocation.js";

const B1 = "b1", B2 = "b2", B3 = "b3";
const childByBrand = { b1: "c1", b2: "c2", b3: "c3" };

describe("splitLineByAllocation — foots exactly, residual to largest share", () => {
  it("clean 60/40", () => {
    const r = splitLineByAllocation(10000, [{ brand_id: B1, pct: 60 }, { brand_id: B2, pct: 40 }], childByBrand);
    expect(r).toEqual([
      { brand_id: B1, account_id: "c1", amount_cents: 6000 },
      { brand_id: B2, account_id: "c2", amount_cents: 4000 },
    ]);
  });
  it("33/33/34 of $100 foots to 10000 with residual on the largest", () => {
    const r = splitLineByAllocation(10000, [{ brand_id: B1, pct: 33 }, { brand_id: B2, pct: 33 }, { brand_id: B3, pct: 34 }], childByBrand);
    expect(r.reduce((s, x) => s + x.amount_cents, 0)).toBe(10000);
    expect(r[2].amount_cents).toBe(3400); // 34% largest holds the exact remainder
  });
  it("odd amount (10001 @ 50/50) still foots exactly", () => {
    const r = splitLineByAllocation(10001, [{ brand_id: B1, pct: 50 }, { brand_id: B2, pct: 50 }], childByBrand);
    expect(r.reduce((s, x) => s + x.amount_cents, 0)).toBe(10001);
  });
  it("preserves sign for negatives", () => {
    const r = splitLineByAllocation(-10000, [{ brand_id: B1, pct: 70 }, { brand_id: B2, pct: 30 }], childByBrand);
    expect(r.reduce((s, x) => s + x.amount_cents, 0)).toBe(-10000);
    expect(r[0].amount_cents).toBe(-7000);
  });
});

// Mock admin: account a-roll is a brand-rollup with a 60/40 rule + children;
// a-plain is a normal account (no split).
function mockAdmin() {
  return {
    from(table) {
      const q = {
        _table: table, _eq: {},
        select() { return q; },
        eq(col, val) { q._eq[col] = val; return q; },
        async maybeSingle() {
          if (q._table === "gl_accounts") {
            return { data: q._eq.id === "a-roll" ? { id: "a-roll", brand_rollup: true } : { id: q._eq.id, brand_rollup: false } };
          }
          return { data: null };
        },
        then(resolve) {
          // non-maybeSingle awaited query (returns array)
          if (q._table === "brand_account_allocations") return resolve({ data: [{ brand_id: B1, pct: 60 }, { brand_id: B2, pct: 40 }] });
          if (q._table === "gl_accounts" && q._eq.parent_account_id === "a-roll")
            return resolve({ data: [{ id: "c1", brand_id: B1 }, { id: "c2", brand_id: B2 }] });
          return resolve({ data: [] });
        },
      };
      return q;
    },
  };
}

describe("expandJeLines", () => {
  afterEach(() => { delete process.env.BRAND_SCOPE_MODE; });

  it("is a NO-OP when not enforcing (returns lines unchanged)", async () => {
    delete process.env.BRAND_SCOPE_MODE;
    const lines = [{ line_number: 1, account_id: "a-roll", debit: "100.00", credit: "0" }];
    expect(await expandJeLines(mockAdmin(), lines)).toBe(lines);
  });

  it("splits a rollup debit line into brand children, renumbered + balanced", async () => {
    process.env.BRAND_SCOPE_MODE = "enforce";
    const lines = [
      { line_number: 1, account_id: "a-roll", debit: "100.00", credit: "0", memo: "rent" },
      { line_number: 2, account_id: "a-plain", debit: "0", credit: "100.00" },
    ];
    const out = await expandJeLines(mockAdmin(), lines);
    expect(out).toHaveLength(3); // 2 split children + 1 untouched
    expect(out[0]).toMatchObject({ line_number: 1, account_id: "c1", brand_id: B1, debit: "60.00", credit: "0", memo: "rent" });
    expect(out[1]).toMatchObject({ line_number: 2, account_id: "c2", brand_id: B2, debit: "40.00", credit: "0" });
    expect(out[2]).toMatchObject({ line_number: 3, account_id: "a-plain", credit: "100.00" });
    // debits (60+40) still equal the 100 credit → balanced
    const deb = out.reduce((s, l) => s + Number(l.debit), 0);
    const cred = out.reduce((s, l) => s + Number(l.credit), 0);
    expect(deb).toBeCloseTo(cred, 2);
  });
});
