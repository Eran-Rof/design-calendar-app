// Guards the SKU-CREATE colour path (the 2026-07 duplicate-colourway leak).
//
// Symptom that motivated this: style RYB0991 carried "Black Paradise" (created
// 04-26, 40 sales rows) AND "Blck Paradise" (created 07-01/07-17, 0 sales rows).
// One physical colourway, two ATS lines — size 36 on-hand sat under one spelling
// and size 30 under the other. canonColor() expands only a handful of tokens, so
// "Blck Paradise" canonicalised to itself, failed to match, and minted a second
// SKU. resolveOrCreateSku now matches on colorMatchKey (the full COLOR_ABBR
// dictionary) and adopts the established spelling.
import { describe, it, expect } from "vitest";
import { canonColor, resolveOrCreateSku } from "../styleMatrix.js";
import { colorMatchKey } from "../xoroLineMatch.js";

const STYLE_ID = "11111111-1111-1111-1111-111111111111";
const ENTITY_ID = "22222222-2222-2222-2222-222222222222";

// Minimal chainable PostgREST double. Filters are applied in-memory so the test
// exercises the REAL matching logic rather than a stubbed answer.
function fakeAdmin(rows, { onInsert } = {}) {
  const store = { items: rows.map((r, i) => ({ id: r.id || `sku-${i}`, entity_id: ENTITY_ID, style_id: STYLE_ID, inseam: null, length: null, fit: null, is_apparel: false, created_at: r.created_at || "2026-01-01", ...r })) };
  function builder(table) {
    let set = table === "ip_item_master" ? store.items.slice() : [{ style_code: "RYB0991" }];
    const api = {
      select: () => api,
      eq: (col, val) => { set = set.filter((r) => String(r[col]) === String(val)); return api; },
      not: (col, _op, _val) => { set = set.filter((r) => r[col] != null); return api; },
      in: (col, vals) => { set = set.filter((r) => vals.map(String).includes(String(r[col]))); return api; },
      order: () => { set = set.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))); return api; },
      limit: () => api,
      maybeSingle: async () => ({ data: set[0] ?? null }),
      single: async () => ({ data: set[0] ?? null, error: null }),
      insert: (row) => { onInsert?.(row); const created = { ...row, id: "sku-new" }; store.items.push(created); return { select: () => ({ single: async () => ({ data: created, error: null }) }) }; },
      then: (resolve) => resolve({ data: set, error: null }),
    };
    return api;
  }
  return { from: builder };
}

describe("resolveOrCreateSku colour handling", () => {
  it("reuses the existing SKU when the caller writes an abbreviated spelling", async () => {
    const admin = fakeAdmin([
      { id: "existing-31", sku_code: "RYB0991-BLCK-PARADISE-31", color: "Black Paradise", size: "31" },
    ]);
    const out = await resolveOrCreateSku(admin, ENTITY_ID, {
      style_id: STYLE_ID, style_code: "RYB0991", color: "Blck Paradise", size: "31",
    }, { isApparel: false });
    expect(out).toEqual({ id: "existing-31", created: false });
  });

  it("inherits the established spelling when creating a NEW size", async () => {
    let inserted = null;
    const admin = fakeAdmin([
      { sku_code: "RYB0991-BLCK-PARADISE-31", color: "Black Paradise", size: "31", created_at: "2026-04-26" },
      { sku_code: "RYB0991-BLCKPARADISE-33", color: "Blck Paradise", size: "33", created_at: "2026-07-17" },
    ], { onInsert: (r) => { inserted = r; } });
    const out = await resolveOrCreateSku(admin, ENTITY_ID, {
      style_id: STYLE_ID, style_code: "RYB0991", color: "Blck Paradise", size: "32",
    }, { isApparel: false });
    expect(out.created).toBe(true);
    // OLDEST spelling wins, not the one the caller handed us and not canonColor's.
    expect(inserted.color).toBe("Black Paradise");
    expect(inserted.sku_code).toBe("RYB0991-BLACK-PARADISE-32");
  });

  it("tags the creator so a future duplicate burst is attributable by query", async () => {
    let inserted = null;
    const admin = fakeAdmin([], { onInsert: (r) => { inserted = r; } });
    await resolveOrCreateSku(admin, ENTITY_ID, {
      style_id: STYLE_ID, style_code: "RYB0991", color: "Black Paradise", size: "32",
    }, { isApparel: false, source: "ar_size_enrich" });
    expect(inserted.attributes).toEqual({ source: "ar_size_enrich" });
  });

  it("does not bind a colourless row to a real colourway", async () => {
    let inserted = null;
    const admin = fakeAdmin([
      { id: "colourless", sku_code: "RYB0991-32", color: null, size: "32" },
    ], { onInsert: (r) => { inserted = r; } });
    const out = await resolveOrCreateSku(admin, ENTITY_ID, {
      style_id: STYLE_ID, style_code: "RYB0991", color: "Black Paradise", size: "32",
    }, { isApparel: false });
    expect(out.created).toBe(true);
    expect(inserted.color).toBe("Black Paradise");
  });
});

describe("colorMatchKey is strictly wider than canonColor", () => {
  // The create path swapped canonColor for colorMatchKey. That is only safe if
  // every pair canonColor already collapsed is also collapsed by colorMatchKey —
  // otherwise the swap would LOSE existing matches and fork rows it used to reuse.
  const samples = [
    "Black", "BLACK", "Blck Paradise", "Black Paradise",
    "SKYFALL - Light Wash", "SKYFALL - Lt Wash", "Light Brown", "LT BROWN",
    "Simple Sage Combo", "Simple Sage Cbo", "WOODLAND CAM", "WOODLAND CAMO",
    "Open Sea - Light Wash w Tint", "Open Sea - Lt Wash with Tint",
    "Navy/Peach", "NAVY/PEACH", "Forget-Me-Not", "FORGET-ME-NOT",
    "Americana- Mdblue", "Americana - Medium Blue", "Salt Wash", "Willow", "Camel",
  ];
  it("collapses every pair canonColor collapses", () => {
    for (const a of samples) {
      for (const b of samples) {
        if (canonColor(a) === canonColor(b)) {
          expect(`${a}|${b}|${colorMatchKey(a)}`).toBe(`${a}|${b}|${colorMatchKey(b)}`);
        }
      }
    }
  });
  it("catches the abbreviations canonColor misses", () => {
    expect(colorMatchKey("Blck Paradise")).toBe(colorMatchKey("Black Paradise"));
    expect(colorMatchKey("Americana- Mdblue")).toBe(colorMatchKey("Americana - Medium Blue"));
    expect(canonColor("Blck Paradise")).toBe(canonColor("Black Paradise")); // BLCK is in both maps
    // …but these are ONLY in COLOR_ABBR, which is why the create path had to move.
    expect(canonColor("Americana- Mdblue")).not.toBe(canonColor("Americana - Medium Blue"));
  });
  it("keeps genuinely different colours apart", () => {
    expect(colorMatchKey("Ltblueberry")).not.toBe(colorMatchKey("Light Blue Berry"));
    expect(colorMatchKey("Camel")).not.toBe(colorMatchKey("Camo"));
  });
});
