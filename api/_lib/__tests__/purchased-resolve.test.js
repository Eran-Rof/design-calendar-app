// Tests for api/_lib/purchasedResolve.js — the per-BUCKET "Purchased" preference
// shared by inventory-snapshot.js (the column) and inventory-purchased-detail.js
// (the drill). Guards the #1747 receipts-feed-vs-06-28-AP-bill double-count fix:
// when a (style,color) bucket carries BOTH the Xoro receipts mirror AND the AP
// vendor bill for the same goods, Purchased must count the goods ONCE — receipts
// win where present, the bill total only backstops uncovered buckets.

import { describe, it, expect } from "vitest";
import { resolvePurchased, purchasedSource, buildBillInfoIndex, pickBillInfoFor } from "../purchasedResolve.js";

describe("resolvePurchased", () => {
  it("receipts-only bucket → receipts total", () => {
    expect(resolvePurchased(2356, 0)).toBe(2356);
  });

  it("bills-only bucket (bills-only native flow / pre-Aug-2024) → bill total backstop", () => {
    expect(resolvePurchased(0, 480)).toBe(480);
  });

  it("BOTH feeds present (the Xoro-world double-count) → receipts WIN, counted once", () => {
    // RYB1878 / Open Sea - Light Wash W Tint: receipts 2,356 + bill 2,356 → the
    // screen used to show 4,712; the fix returns the Xoro truth 2,356.
    expect(resolvePurchased(2356, 2356)).toBe(2356);
  });

  it("BOTH present with differing totals still prefers receipts (authoritative unit feed)", () => {
    expect(resolvePurchased(2356, 1800)).toBe(2356);
  });

  it("zero-zero bucket → 0", () => {
    expect(resolvePurchased(0, 0)).toBe(0);
  });

  it("coerces null/undefined/NaN feeds to 0 (never NaN)", () => {
    expect(resolvePurchased(null, undefined)).toBe(0);
    expect(resolvePurchased(undefined, 120)).toBe(120);
    expect(resolvePurchased(NaN, NaN)).toBe(0);
  });

  it("PPK explosion is upstream: exploded totals resolve the same way (receipts win)", () => {
    // Both feeds already ×units-per-pack (e.g. 100 packs → 2400 eaches) before
    // resolve; the preference is unchanged by explosion.
    const packs = { receipts: 100, bill: 100 };
    const units = 24;
    expect(resolvePurchased(packs.receipts * units, packs.bill * units)).toBe(2400);
  });
});

describe("purchasedSource (drill labelling)", () => {
  it("labels a bucket with receipts as receipts-sourced", () => {
    expect(purchasedSource(2356)).toBe("receipts");
  });
  it("labels a bucket without receipts as bill-sourced (fallback)", () => {
    expect(purchasedSource(0)).toBe("bills");
    expect(purchasedSource(null)).toBe("bills");
  });
  it("agrees with resolvePurchased on which feed supplies the number", () => {
    // Where source is receipts, resolvePurchased must return the receipts total,
    // not the bill total — the invariant the drill relies on to tie to the column.
    const cases = [[2356, 2356], [500, 0], [0, 480], [0, 0]];
    for (const [rc, bl] of cases) {
      const src = purchasedSource(rc);
      expect(resolvePurchased(rc, bl)).toBe(src === "receipts" ? rc : bl);
    }
  });
});

// ── Receipt-row enrichment from the matching vendor bill ────────────────────
// The receipts feed carries no unit price / bill date and its vendor_id points
// at an empty master, so the drill decorates each receipt row from the bill for
// the same PO (the CEO-reported "receipt shows no vendor / unit price / bill
// date"). Quantity always stays the receipt's.
describe("buildBillInfoIndex / pickBillInfoFor (receipt enrichment)", () => {
  const bill = (over = {}) => ({
    po_number: "ROF-P001128", color: "Open Sea - Light Wash W Tint",
    vendor: "Guangzhou Blue Denim Apparel Co., Ltd", unit_price: 5.85,
    bill_date: "2026-06-30", bill_id: "b-1", ref: "ROF-B006639", ...over,
  });

  it("exact (po_number, color) match wins", () => {
    const idx = buildBillInfoIndex([bill(), bill({ po_number: "ROF-P999999", bill_id: "b-2" })]);
    const hit = pickBillInfoFor({ po_number: "ROF-P001128", color: "Open Sea - Light Wash W Tint" }, idx);
    expect(hit?.bill_id).toBe("b-1");
    expect(hit?.vendor).toMatch(/Guangzhou/);
    expect(hit?.unit_price).toBe(5.85);
    expect(hit?.bill_date).toBe("2026-06-30");
  });

  it("latest bill_date wins when two bills share (po, color)", () => {
    const idx = buildBillInfoIndex([
      bill({ bill_id: "older", bill_date: "2026-05-01" }),
      bill({ bill_id: "newer", bill_date: "2026-06-30" }),
    ]);
    expect(pickBillInfoFor({ po_number: "ROF-P001128", color: "Open Sea - Light Wash W Tint" }, idx)?.bill_id).toBe("newer");
  });

  it("falls back to the colour's SINGLE bill when the receipt has no PO match", () => {
    const idx = buildBillInfoIndex([bill()]);
    expect(pickBillInfoFor({ po_number: null, color: "Open Sea - Light Wash W Tint" }, idx)?.bill_id).toBe("b-1");
    expect(pickBillInfoFor({ po_number: "ROF-P424242", color: "Open Sea - Light Wash W Tint" }, idx)?.bill_id).toBe("b-1");
  });

  it("NEVER guesses between multiple colour-level candidates", () => {
    const idx = buildBillInfoIndex([bill({ bill_id: "b-1" }), bill({ bill_id: "b-2", po_number: "ROF-P2" })]);
    expect(pickBillInfoFor({ po_number: null, color: "Open Sea - Light Wash W Tint" }, idx)).toBeNull();
  });

  it("colour buckets are isolated (null colour ≠ named colour)", () => {
    const idx = buildBillInfoIndex([bill({ color: null })]);
    expect(pickBillInfoFor({ po_number: "ROF-P001128", color: "Open Sea - Light Wash W Tint" }, idx)).toBeNull();
    expect(pickBillInfoFor({ po_number: "ROF-P001128", color: null }, idx)?.bill_id).toBe("b-1");
  });

  it("tolerates empty/null input", () => {
    const idx = buildBillInfoIndex([]);
    expect(pickBillInfoFor({ po_number: "X", color: "Y" }, idx)).toBeNull();
    expect(pickBillInfoFor(null, idx)).toBeNull();
    expect(pickBillInfoFor({ color: "Y" }, null)).toBeNull();
  });
});
