import { describe, it, expect } from "vitest";
import { mapExcelToAppPalette } from "../exportPreviewMapping";

// Every row in the mapping table from exportPreviewMapping.ts. If a
// future change adds another row, mirror it here so the regression net
// covers it explicitly — the modal's visual identity depends on each
// remap being applied.

describe("mapExcelToAppPalette", () => {
  describe("shared theme palette → TH equivalents", () => {
    it("remaps HEADER_DARK (1F497D) to TH.header (2D3748)", () => {
      expect(mapExcelToAppPalette("1F497D")).toBe("2D3748");
    });

    it("remaps HEADER_TEXT (3278CC) to TH.textSub2 (4A5568)", () => {
      expect(mapExcelToAppPalette("3278CC")).toBe("4A5568");
    });

    it("remaps HEADER_ONHAND (4081D0) to TH.text (1A202C)", () => {
      expect(mapExcelToAppPalette("4081D0")).toBe("1A202C");
    });

    it("remaps ZEBRA_EVEN (EEF3FA) to TH.surfaceHi (F7F8FA)", () => {
      expect(mapExcelToAppPalette("EEF3FA")).toBe("F7F8FA");
    });

    it("keeps ZEBRA_ODD (FFFFFF) as TH.surface (FFFFFF)", () => {
      expect(mapExcelToAppPalette("FFFFFF")).toBe("FFFFFF");
    });

    it("remaps QTY_BAND (B4C7E7) to TH.accent (FFF5F5)", () => {
      expect(mapExcelToAppPalette("B4C7E7")).toBe("FFF5F5");
    });

    it("remaps LOW_STOCK_BG (FFEB9C) to TH.accentBdr (FEB2B2)", () => {
      expect(mapExcelToAppPalette("FFEB9C")).toBe("FEB2B2");
    });

    it("remaps LOW_STOCK_FG (7F6000) to TH.primary (C8210A)", () => {
      expect(mapExcelToAppPalette("7F6000")).toBe("C8210A");
    });

    it("remaps PPK_TEXT (B0BAC9) to TH.textMuted (718096)", () => {
      expect(mapExcelToAppPalette("B0BAC9")).toBe("718096");
    });

    it("remaps the totals-row yellow (FFE699) to TH.accent (FFF5F5)", () => {
      expect(mapExcelToAppPalette("FFE699")).toBe("FFF5F5");
    });
  });

  describe("input normalization", () => {
    it("accepts lowercase hex and returns uppercased mapped value", () => {
      expect(mapExcelToAppPalette("1f497d")).toBe("2D3748");
    });

    it("accepts a leading # and strips it", () => {
      expect(mapExcelToAppPalette("#1F497D")).toBe("2D3748");
    });

    it("accepts mixed case + leading #", () => {
      expect(mapExcelToAppPalette("#1f497D")).toBe("2D3748");
    });
  });

  describe("unmapped hex passthrough", () => {
    it("returns the normalized hex for a code not in the table", () => {
      // C0392B is Neg-Inven's red — intentionally NOT remapped because
      // its semantic meaning ("this is a negative inventory cell") is
      // the signal the operator looks for.
      expect(mapExcelToAppPalette("C0392B")).toBe("C0392B");
    });

    it("uppercases an unmapped lowercase hex", () => {
      expect(mapExcelToAppPalette("c0392b")).toBe("C0392B");
    });

    it("uppercases an unmapped hex with a leading #", () => {
      // The function strips the # during normalization, so passthrough
      // returns the 6-char hex without it. That matches the XLSXStyle
      // rgb convention every cell carries.
      expect(mapExcelToAppPalette("#c0392b")).toBe("C0392B");
    });

    it("returns the raw input for non-hex strings", () => {
      expect(mapExcelToAppPalette("not-a-hex")).toBe("not-a-hex");
    });

    it("returns the raw input for an empty string", () => {
      expect(mapExcelToAppPalette("")).toBe("");
    });

    it("returns the raw input for too-short hex", () => {
      // 3-digit shorthand isn't supported by the Excel rgb convention;
      // we don't try to expand it. Passthrough keeps the caller's
      // expectations stable.
      expect(mapExcelToAppPalette("FFF")).toBe("FFF");
    });
  });
});
