import { describe, it, expect } from "vitest";
import { buildItemRow, parseSizeSuffix, canonStyleColor } from "../sku-canon.js";

describe("parseSizeSuffix", () => {
  it("returns the trailing size token when present", () => {
    expect(parseSizeSuffix("100215186MN-STONEBLOCKGD-LARGE")).toBe("LARGE");
    expect(parseSizeSuffix("100232159TG-MEDIUMWASH-12MO")).toBe("12MO");
    expect(parseSizeSuffix("FYB0004-THUNDERBOLT-DARKWASH-30")).toBe("30");
    expect(parseSizeSuffix("PTYT0023C-FALCON-SML")).toBe("SML");
  });
  it("returns null for style+color rollups (no size axis in the code)", () => {
    expect(parseSizeSuffix("RYB086930-BLACK")).toBeNull();
    expect(parseSizeSuffix("100206796GK-MILLIEWASH")).toBeNull();
    // canonStyleColor output is, by definition, size-less.
    expect(parseSizeSuffix(canonStyleColor("RYB086930-BLACK-30"))).toBeNull();
  });
});

describe("buildItemRow", () => {
  it("minimal stub sets is_apparel:false so apparel_dims_required can't reject it", () => {
    // Regression: a minimal stub with is_apparel defaulting to true and no
    // size/inseam/length/fit violates ip_item_master's apparel_dims_required
    // CHECK, erroring the insert chunk and dropping the SKU from the sync
    // ("no id for <sku> after stub insert" in planning-sync). The 2026-06-03
    // nightly lost 31 new color/wash variants this way.
    const row = buildItemRow("RYB059430-CRUMBLE-MEDBLU");
    expect(row.is_apparel).toBe(false);
    expect(row.sku_code).toBe("RYB059430-CRUMBLE-MEDBLU");
    expect(row.style_code).toBe("RYB059430");
    expect(row.active).toBe(true);
    expect(row.uom).toBe("each");
  });

  it("minimal stub populates size from a trailing size token so matrices can place it", () => {
    // Regression (AR-mirror size resolution): a size-bearing stub used to land
    // with size=NULL, so the AR color x size matrix dropped it into the
    // non-matrix "other lines" bucket even though the size is in the code.
    const row = buildItemRow("100215186MN-STONEBLOCKGD-LARGE");
    expect(row.size).toBe("LARGE");
    expect(row.is_apparel).toBe(false); // still false — apparel_dims_required is only enforced when true
  });

  it("minimal stub for a style+color rollup stays size-less", () => {
    const row = buildItemRow("RYB086930-BLACK");
    expect(row.size).toBeUndefined();
  });

  it("non-minimal (Excel uploader) row does NOT force is_apparel:false", () => {
    // The Excel uploader is authoritative and may set a fully-dimensioned
    // apparel row; the stub-only guard must not bleed into that path.
    const row = buildItemRow("RYB1469OB-BLACK", { minimal: false, description: "Denim" });
    expect(row.is_apparel).toBeUndefined();
    expect(row.color).toBe("BLACK");
    expect(row.description).toBe("Denim");
  });
});
