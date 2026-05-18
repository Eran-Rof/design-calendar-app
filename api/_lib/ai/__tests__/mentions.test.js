// Unit tests for the @mention autocomplete lookups (PR 2/4).
// Pinned behaviours:
//   - Customer ranking prefers exact-canonical > startsWith-either-way
//     > plain inclusion. Critical for Xoro name drift (Ross / ROSS /
//     Ross Procurement etc.).
//   - Style ranking prefers exact-code > prefix > includes, and the
//     description-substring path doesn't accidentally hide a closer
//     style_code match.
//   - Unknown `type` returns a structured error, not an exception.

import { describe, it, expect } from "vitest";
import {
  scoreCustomerRow,
  suggestCustomers,
  suggestStyles,
  suggestMentions,
} from "../mentions.js";

// ────────────────────────────────────────────────────────────────────────
// Pure helper
// ────────────────────────────────────────────────────────────────────────

describe("scoreCustomerRow", () => {
  it("scores exact canonical match highest", () => {
    expect(scoreCustomerRow({ name: "Ross" }, "Ross")).toBe(3);
    expect(scoreCustomerRow({ name: "ROSS" }, "ross")).toBe(3); // canonical is case-insensitive
  });
  it("rewards prefix match in either direction", () => {
    expect(scoreCustomerRow({ name: "Ross Procurement, Inc." }, "Ross")).toBe(2);
    expect(scoreCustomerRow({ name: "Burlington" }, "Burlington Coat Factory")).toBe(2);
  });
  it("plain inclusion gets the lowest non-zero score", () => {
    expect(scoreCustomerRow({ name: "Pacific Sunwear" }, "Sunwear")).toBe(1);
  });
  it("non-match returns 0", () => {
    expect(scoreCustomerRow({ name: "Burlington" }, "Macys")).toBe(0);
  });
  it("missing inputs return 0 without throwing", () => {
    expect(scoreCustomerRow({}, "x")).toBe(0);
    expect(scoreCustomerRow({ name: "x" }, "")).toBe(0);
    expect(scoreCustomerRow(null, "x")).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fake Supabase builder
// ────────────────────────────────────────────────────────────────────────

function fakeDb(rows, error = null) {
  const builder = {
    _calls: [],
    from(t) { this._calls.push(["from", t]); return this; },
    select(s) { this._calls.push(["select", s]); return this; },
    ilike(c, v) { this._calls.push(["ilike", c, v]); return this; },
    or(s) { this._calls.push(["or", s]); return this; },
    eq(c, v) { this._calls.push(["eq", c, v]); return this; },
    limit(n) { this._calls.push(["limit", n]); return this; },
    then(resolve) { resolve({ data: rows, error }); },
  };
  return builder;
}

// ────────────────────────────────────────────────────────────────────────
// suggestCustomers
// ────────────────────────────────────────────────────────────────────────

describe("suggestCustomers", () => {
  it("returns empty list for empty query without hitting the DB", async () => {
    const db = fakeDb([]);
    const out = await suggestCustomers(db, "");
    expect(out.items).toEqual([]);
    expect(db._calls).toEqual([]);
  });

  it("ilikes on the first word to handle multi-word names", async () => {
    const db = fakeDb([]);
    await suggestCustomers(db, "Burlington Coat Factory");
    const il = db._calls.find(c => c[0] === "ilike");
    expect(il[1]).toBe("name");
    expect(il[2]).toBe("Burlington%");
  });

  it("ranks exact > prefix > includes and shapes the result for the dropdown", async () => {
    const rows = [
      { id: "1", name: "Ross Stores",                customer_code: "ROSS-01" },
      { id: "2", name: "Ross",                       customer_code: "ROSS-EXACT" },
      { id: "3", name: "Ross Procurement, Inc.",     customer_code: "ROSS-02" },
    ];
    const out = await suggestCustomers(fakeDb(rows), "Ross");
    expect(out.items[0].id).toBe("2"); // exact wins
    expect(out.items[0].label).toBe("Ross");
    expect(out.items[0].sublabel).toBe("Customer · ROSS-EXACT");
    // Remaining two prefix matches sort by name asc:
    // "Ross Procurement, Inc." ('P' < 'S') comes before "Ross Stores".
    expect(out.items.map(i => i.id)).toEqual(["2", "3", "1"]);
  });

  it("caps to 8 results", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, name: `Burlington ${i}`, customer_code: `B${i}`,
    }));
    const out = await suggestCustomers(fakeDb(rows), "Burlington");
    expect(out.items).toHaveLength(8);
  });

  it("surfaces DB errors as a structured shape", async () => {
    const out = await suggestCustomers(fakeDb(null, { message: "denied" }), "Ross");
    expect(out.error).toBe("denied");
    expect(out.items).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// suggestStyles
// ────────────────────────────────────────────────────────────────────────

describe("suggestStyles", () => {
  it("returns empty for empty query without hitting the DB", async () => {
    const db = fakeDb([]);
    const out = await suggestStyles(db, "");
    expect(out.items).toEqual([]);
    expect(db._calls).toEqual([]);
  });

  it("escapes % and _ wildcards so an operator-typed % isn't injected", async () => {
    const db = fakeDb([]);
    await suggestStyles(db, "RYB%X");
    const or = db._calls.find(c => c[0] === "or");
    expect(or[1]).toContain("RYB\\%X");
  });

  it("dedupes to one entry per style_code, preferring the highest score", async () => {
    const rows = [
      { sku_code: "RYB0412PPK24-A", style_code: "RYB0412", description: "Edge jogger pack", active: true },
      { sku_code: "RYB0412-S",       style_code: "RYB0412", description: "Edge jogger small",  active: true },
      { sku_code: "OTHER",           style_code: "RYB0413", description: "RYB0412 wannabe",   active: true },
    ];
    const out = await suggestStyles(fakeDb(rows), "RYB0412");
    expect(out.items.map(i => i.id)).toEqual(["RYB0412", "RYB0413"]);
    expect(out.items[0].label).toBe("RYB0412");
    expect(out.items[0].sublabel).toMatch(/Style ·/);
  });

  it("exact code match beats description includes", async () => {
    const rows = [
      { sku_code: "X", style_code: "RYB0412 referenced", description: "x", active: true },
      { sku_code: "Y", style_code: "RYB0412",            description: "edge", active: true },
    ];
    const out = await suggestStyles(fakeDb(rows), "RYB0412");
    expect(out.items[0].id).toBe("RYB0412");
  });
});

// ────────────────────────────────────────────────────────────────────────
// suggestMentions dispatcher
// ────────────────────────────────────────────────────────────────────────

describe("suggestMentions", () => {
  it("routes type=customer to suggestCustomers", async () => {
    const out = await suggestMentions(fakeDb([]), { query: "ross", type: "customer" });
    expect(out.items).toEqual([]);
  });
  it("routes type=style to suggestStyles", async () => {
    const out = await suggestMentions(fakeDb([]), { query: "RYB", type: "style" });
    expect(out.items).toEqual([]);
  });
  it("returns a structured error on unknown type", async () => {
    const out = await suggestMentions(fakeDb([]), { query: "x", type: "vendor" });
    expect(out.error).toMatch(/unknown type/);
    expect(out.items).toEqual([]);
  });
});
