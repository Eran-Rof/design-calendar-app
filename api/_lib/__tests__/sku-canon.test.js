import { describe, it, expect } from "vitest";
import { buildItemRow, parseSizeSuffix, canonStyleColor, prettyColorFromItemNumber, isBareShellItemRow, dropBareShellRows } from "../sku-canon.js";

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

  it("minimal stub populates color from the sku_code so matrices don't collapse", () => {
    // Regression (PO/SO/AR matrix collapse): a colourless stub lands with
    // color=NULL, and the size-matrix gate (style_code && size) drops or
    // collapses every line of the style to one "—" row. The colour is in the SKU.
    const size = buildItemRow("100215186MN-STONEBLOCKGD-LARGE");
    expect(size.color).toBe("STONEBLOCKGD");
    const rollup = buildItemRow("RYB086930-BLACK");
    expect(rollup.color).toBe("BLACK");
  });

  it("minimal stub prefers a caller-supplied pretty colorDisplay over the squished key", () => {
    const row = buildItemRow("RYB059530PPK-ISLANDBREEZELTWASH-PPK24", {
      colorDisplay: "Island Breeze Lt Wash",
    });
    expect(row.color).toBe("Island Breeze Lt Wash");
  });

  it("minimal stub with no parseable colour omits color", () => {
    const row = buildItemRow("100203712MN"); // bare style token, no colour segment
    expect(row.color).toBeUndefined();
  });
});

describe("isBareShellItemRow (junk bare-shell suppression predicate)", () => {
  it("flags a style-code-only stub with no colour (the nightly resurrection bug)", () => {
    // These exact codes were deleted 07-20 and resurrected by the 07-21 nightly:
    // colourless STYLE(-SIZE) Xoro lines roll up to a bare style token, which
    // buildItemRow mints as sku_code === style_code, color=NULL, size=NULL.
    expect(isBareShellItemRow(buildItemRow("RYB1878"))).toBe(true);
    expect(isBareShellItemRow(buildItemRow("RYB1895"))).toBe(true);
    expect(isBareShellItemRow(buildItemRow("RYO0659FPPPK"))).toBe(true);
    expect(isBareShellItemRow(buildItemRow("SP26TB1423PPK"))).toBe(true);
    expect(isBareShellItemRow(buildItemRow("100203712MN"))).toBe(true);
  });

  it("does NOT flag a legitimate colour-bearing stub (rollup or size-grain)", () => {
    expect(isBareShellItemRow(buildItemRow("RYB086930-BLACK"))).toBe(false);          // style+colour rollup
    expect(isBareShellItemRow(buildItemRow("RYB059430-CRUMBLE-MEDBLU"))).toBe(false); // style+colour
    expect(isBareShellItemRow(buildItemRow("100215186MN-STONEBLOCKGD-LARGE"))).toBe(false); // size-grain, coloured
    expect(isBareShellItemRow(buildItemRow("RYB059530PPK-ISLANDBREEZELTWASH-PPK24", {
      colorDisplay: "Island Breeze Lt Wash",
    }))).toBe(false); // PPK pack WITH colour
  });

  it("does NOT flag a row whose sku_code carries a colour segment even if color is unset", () => {
    // A dash-delimited STYLE-COLOR row is never a bare shell, regardless of the
    // color field — conservative: only the segment-less bare style token is junk.
    expect(isBareShellItemRow({ sku_code: "RYB1878-NAVY", color: null })).toBe(false);
  });

  it("is null/shape safe", () => {
    expect(isBareShellItemRow(null)).toBe(false);
    expect(isBareShellItemRow(undefined)).toBe(false);
    expect(isBareShellItemRow({})).toBe(false); // no sku_code → not classifiable as a shell
  });

  it("dropBareShellRows partitions a build batch and counts the suppressed shells", () => {
    const built = [
      buildItemRow("RYB086930-BLACK"),   // keep
      buildItemRow("RYB1878"),           // drop (bare shell)
      buildItemRow("RYB1880"),           // drop (bare shell)
      buildItemRow("100215186MN-STONEBLOCKGD-LARGE"), // keep
    ];
    const { rows, suppressed } = dropBareShellRows(built);
    expect(suppressed).toBe(2);
    expect(rows.map((r) => r.sku_code)).toEqual(["RYB086930-BLACK", "100215186MN-STONEBLOCKGD-LARGE"]);
  });

  it("dropBareShellRows on an empty/nullish batch is a no-op", () => {
    expect(dropBareShellRows([])).toEqual({ rows: [], suppressed: 0 });
    expect(dropBareShellRows(null)).toEqual({ rows: [], suppressed: 0 });
  });
});

describe("prettyColorFromItemNumber", () => {
  it("preserves + title-cases the readable colour segment of a raw ItemNumber", () => {
    expect(prettyColorFromItemNumber("RYB059530PPK-Island Breeze lt wash-PPK24"))
      .toBe("Island Breeze Lt Wash");
    expect(prettyColorFromItemNumber("PTYG0001H-Black-M")).toBe("Black");
    expect(prettyColorFromItemNumber("RYB059430-Island Breeze Lt Wash-30"))
      .toBe("Island Breeze Lt Wash");
  });
  it("strips paren-range kids' sizes without eating the colour", () => {
    expect(prettyColorFromItemNumber("100206796GK-Millie Wash-L(14-16)")).toBe("Millie Wash");
  });
  it("returns the colour for a size-less style+colour ItemNumber", () => {
    expect(prettyColorFromItemNumber("RYB086930-Black")).toBe("Black");
  });
  it("returns null when the ItemNumber carries no colour segment", () => {
    expect(prettyColorFromItemNumber("100203712MN")).toBeNull();
    expect(prettyColorFromItemNumber("")).toBeNull();
    expect(prettyColorFromItemNumber(null)).toBeNull();
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
