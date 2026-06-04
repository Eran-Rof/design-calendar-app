import { describe, it, expect } from "vitest";
import { buildItemRow } from "../sku-canon.js";

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

  it("non-minimal (Excel uploader) row does NOT force is_apparel:false", () => {
    // The Excel uploader is authoritative and may set a fully-dimensioned
    // apparel row; the stub-only guard must not bleed into that path.
    const row = buildItemRow("RYB1469OB-BLACK", { minimal: false, description: "Denim" });
    expect(row.is_apparel).toBeUndefined();
    expect(row.color).toBe("BLACK");
    expect(row.description).toBe("Denim");
  });
});
