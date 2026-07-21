// Tests for api/_lib/spineSnapshot.js
//
// Pure JS — no DB/network. Covers the by-size snapshot writer's aggregation
// (buildSnapshotUpserts), filename date parse (csvDateFromName) and the prune
// predicate (pruneReason) used by scripts/sync-onhand-spine.mjs.

import { describe, it, expect } from "vitest";
import { buildSnapshotUpserts, pruneReason, csvDateFromName, cellKey } from "../spineSnapshot.js";

describe("csvDateFromName", () => {
  it("parses YYYYMMDD out of a full postAD_invrest path", () => {
    expect(csvDateFromName("C:/logs/postAD_invrest_20260720211724.csv")).toBe("2026-07-20");
  });
  it("parses a bare filename", () => {
    expect(csvDateFromName("postAD_invrest_20260101.csv")).toBe("2026-01-01");
  });
  it("returns null when there is no date", () => {
    expect(csvDateFromName("postAD_invrest_latest.csv")).toBeNull();
    expect(csvDateFromName("")).toBeNull();
    expect(csvDateFromName(null)).toBeNull();
  });
});

describe("buildSnapshotUpserts", () => {
  const D = "2026-07-20";
  it("aggregates qty per (item, warehouse) and rounds", () => {
    const cells = [
      { sku: "i1", store: "ROF Main", qty: 10 },
      { sku: "i1", store: "ROF Main", qty: 5 },     // same cell → summed
      { sku: "i1", store: "ROF - ECOM", qty: 3 },   // different warehouse → separate
      { sku: "i2", store: "ROF Main", qty: 2.4 },   // rounds to 2
    ];
    const out = buildSnapshotUpserts(cells, null, D);
    expect(out).toEqual(
      expect.arrayContaining([
        { item_id: "i1", warehouse_code: "ROF Main", snapshot_date: D, qty_on_hand: 15 },
        { item_id: "i1", warehouse_code: "ROF - ECOM", snapshot_date: D, qty_on_hand: 3 },
        { item_id: "i2", warehouse_code: "ROF Main", snapshot_date: D, qty_on_hand: 2 },
      ])
    );
    expect(out).toHaveLength(3);
  });
  it("drops non-positive and unresolved cells", () => {
    const cells = [
      { sku: "i1", store: "ROF Main", qty: 0 },
      { sku: "i1", store: "ROF Main", qty: -4 },
      { sku: null, store: "ROF Main", qty: 9 },
      { sku: "i1", store: "", qty: 9 },
      { sku: "i2", store: "ROF Main", qty: 0.4 }, // rounds to 0 → dropped
    ];
    expect(buildSnapshotUpserts(cells, null, D)).toEqual([]);
  });
  it("applies a resolveFn to raw cells", () => {
    const raw = [{ upc: "u1", store: "ROF Main", qty: 7 }];
    const out = buildSnapshotUpserts(raw, (c) => ({ sku: `sku-${c.upc}`, store: c.store, qty: c.qty }), D);
    expect(out).toEqual([{ item_id: "sku-u1", warehouse_code: "ROF Main", snapshot_date: D, qty_on_hand: 7 }]);
  });
  it("keeps warehouse names containing spaces intact", () => {
    const out = buildSnapshotUpserts([{ sku: "i1", store: "Psycho Tuna Ecom", qty: 4 }], null, D);
    expect(out[0].warehouse_code).toBe("Psycho Tuna Ecom");
  });
});

describe("pruneReason", () => {
  const csvDate = "2026-07-20";
  const upsertKeys = new Set([cellKey("i1", "ROF Main")]); // i1@ROF Main got a fresh row today
  const allowedSkus = new Set(["i1", "i2", "i3"]);   // spine-mapped
  const feedItems = new Set(["i1"]);                 // only i1 is in today's feed
  const ctx = { upsertKeys, allowedSkus, feedItems, csvDate };

  it("superseded: older row for a cell re-written today", () => {
    expect(pruneReason({ item_id: "i1", warehouse_code: "ROF Main", snapshot_date: "2026-07-15" }, ctx)).toBe("superseded");
  });
  it("sold-through: older row for a spine item absent from the feed", () => {
    expect(pruneReason({ item_id: "i2", warehouse_code: "ROF Main", snapshot_date: "2026-07-15" }, ctx)).toBe("sold-through");
  });
  it("keeps a non-spine item absent from the feed (coverage gap)", () => {
    expect(pruneReason({ item_id: "xX", warehouse_code: "ROF Main", snapshot_date: "2026-07-15" }, ctx)).toBeNull();
  });
  it("keeps today's freshly-written row (not older than csvDate)", () => {
    expect(pruneReason({ item_id: "i2", warehouse_code: "ROF Main", snapshot_date: "2026-07-20" }, ctx)).toBeNull();
  });
  it("never touches a different source", () => {
    expect(pruneReason({ item_id: "i2", warehouse_code: "ROF Main", snapshot_date: "2026-07-15", source: "manual" }, ctx)).toBeNull();
  });
  it("superseded wins over sold-through when both could apply", () => {
    // i3 is spine-mapped + absent from feed (sold-through), but its cell was also
    // re-written today → superseded is checked first.
    const ctx2 = { ...ctx, upsertKeys: new Set([cellKey("i3", "ROF Main")]) };
    expect(pruneReason({ item_id: "i3", warehouse_code: "ROF Main", snapshot_date: "2026-07-15" }, ctx2)).toBe("superseded");
  });
});
