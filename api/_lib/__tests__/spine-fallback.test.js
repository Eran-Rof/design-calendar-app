// Tests for api/_lib/spineFallback.js
//
// Pure JS — no DB/network. Covers the spine on-hand sync's fallback resolution
// (scripts/sync-onhand-spine.mjs) for feed rows that tie via NEITHER the UPC
// spine NOR the private-label ItemNumber path: the normcode tier (unique
// normalized ItemNumber) and the inseam-aware colour+size tuple tier. The tuple
// tier delegates to xoroLineMatch.js (resolveStyleToken/pickColorSizeMatch),
// exercised here through the real imports.

import { describe, it, expect } from "vitest";
import { normSkuCode, buildNormSkuIndex, buildStyleRowIndex, resolveFallbackSku } from "../spineFallback.js";

describe("normSkuCode", () => {
  it("uppercases and strips every non-alphanumeric", () => {
    expect(normSkuCode("ryb0335-Aloe-Large")).toBe("RYB0335ALOELARGE");
    expect(normSkuCode("PTYG0003lstd-T20 Oceanic Blues-M")).toBe("PTYG0003LSTDT20OCEANICBLUESM");
    expect(normSkuCode(null)).toBe("");
    expect(normSkuCode(undefined)).toBe("");
  });
});

describe("buildNormSkuIndex", () => {
  it("indexes unambiguous normalized sku_codes", () => {
    const idx = buildNormSkuIndex([
      { id: "a", sku_code: "PTYG0003LSTD-T20-OCEANIC-BLUES-SMALL" },
      { id: "b", sku_code: "RYB0335-ALOE-LARGE" },
    ]);
    expect(idx.get("PTYG0003LSTDT20OCEANICBLUESSMALL")).toBe("a");
    expect(idx.get("RYB0335ALOELARGE")).toBe("b");
  });
  it("drops a norm shared by two DIFFERENT item_ids (never guess)", () => {
    const idx = buildNormSkuIndex([
      { id: "a", sku_code: "RG-006-81X" },
      { id: "b", sku_code: "RG00681X" }, // same norm RG00681X → ambiguous
    ]);
    expect(idx.has("RG00681X")).toBe(false);
  });
  it("keeps a norm repeated for the SAME item_id", () => {
    const idx = buildNormSkuIndex([
      { id: "a", sku_code: "X-1" },
      { id: "a", sku_code: "X1" },
    ]);
    expect(idx.get("X1")).toBe("a");
  });
  it("ignores rows missing id or sku_code", () => {
    const idx = buildNormSkuIndex([{ id: "a" }, { sku_code: "Z" }, null]);
    expect(idx.size).toBe(0);
  });
});

describe("buildStyleRowIndex", () => {
  it("groups catalog rows by style_id with tuple fields", () => {
    const m = buildStyleRowIndex([
      { id: "i1", style_id: "s1", color: "Chain", size: "31", inseam: 30 },
      { id: "i2", style_id: "s1", color: "Chain", size: "32", inseam: 30 },
      { id: "i3", style_id: "s2", color: "Aloe", size: "LARGE", inseam: null },
    ]);
    expect(m.get("s1")).toHaveLength(2);
    expect(m.get("s2")[0]).toEqual({ id: "i3", color: "Aloe", size: "LARGE", inseam: null });
  });
  it("skips rows with no style_id", () => {
    const m = buildStyleRowIndex([{ id: "i1", style_id: null, color: "x", size: "M" }]);
    expect(m.size).toBe(0);
  });
});

describe("resolveFallbackSku", () => {
  // Catalog: RYB1862 is an inseam-30 denim program — sized SKUs are coded
  // "RYB186230-<size>" (colour NOT in the code), so ONLY the inseam-aware tuple
  // tier resolves them. PTYG0003LSTD & RYB0335 are colour+size coded.
  const items = [
    { id: "ryb1862-31", style_id: "st-1862", sku_code: "RYB186230-31", color: "Chain", size: "31", inseam: 30 },
    { id: "ryb1862-32", style_id: "st-1862", sku_code: "RYB186230-32", color: "Chain", size: "32", inseam: 30 },
    { id: "lstd-m", style_id: "st-lstd", sku_code: "PTYG0003LSTD-T20-OCEANIC-BLUES-MEDIUM", color: "T20 Oceanic Blues", size: "MEDIUM", inseam: null },
    { id: "aloe-lg", style_id: "st-335", sku_code: "RYB0335-ALOE-LARGE", color: "Aloe", size: "LARGE", inseam: null },
  ];
  const ctx = {
    normIndex: buildNormSkuIndex(items),
    rowsByStyle: buildStyleRowIndex(items),
    styleByCode: new Map([["RYB1862", "st-1862"], ["PTYG0003LSTD", "st-lstd"], ["RYB0335", "st-335"]]),
  };

  it("normcode tier: exact normalized ItemNumber → SKU", () => {
    // catalog spelled size (MEDIUM) matched by an identically-spelled feed code
    const r = resolveFallbackSku({ itemNumber: "ptyg0003lstd-T20 Oceanic Blues-MEDIUM", basePart: "PTYG0003lstd", color: "T20 Oceanic Blues", size: "MEDIUM" }, ctx);
    expect(r).toEqual({ sku: "lstd-m", tier: "normcode" });
  });

  it("inseam tier: peels inseam-30 off the BasePartNumber and binds the size row", () => {
    // BP RYB186230 = style RYB1862 + inseam 30; feed size 32 → RYB186230-32
    const r = resolveFallbackSku({ itemNumber: "RYB186230-Chain-32", basePart: "RYB186230", color: "Chain", size: "32" }, ctx);
    expect(r).toEqual({ sku: "ryb1862-32", tier: "inseam" });
  });

  it("inseam tier tolerates size-abbreviation spelling (Large → LARGE)", () => {
    const r = resolveFallbackSku({ itemNumber: "ryb0335-Aloe-LG", basePart: "RYB0335", color: "Aloe", size: "LG" }, ctx);
    expect(r).toEqual({ sku: "aloe-lg", tier: "inseam" });
  });

  it("unresolved: no size-30 catalog row for the inseam program (genuine gap, never invented)", () => {
    const r = resolveFallbackSku({ itemNumber: "RYB186230-Chain-30", basePart: "RYB186230", color: "Chain", size: "30" }, ctx);
    expect(r).toEqual({ sku: null, tier: "unresolved" });
  });

  it("unresolved: ambiguous colour would give multiple tuple candidates → skip", () => {
    const ambItems = [
      { id: "x1", style_id: "s", sku_code: "AAA-RED-M", color: "Red", size: "M", inseam: null },
      { id: "x2", style_id: "s", sku_code: "AAA-RED-M-DUP", color: "Red", size: "M", inseam: null },
    ];
    const r = resolveFallbackSku(
      { itemNumber: "AAA-Red-M", basePart: "AAA", color: "Red", size: "M" },
      { normIndex: new Map(), rowsByStyle: buildStyleRowIndex(ambItems), styleByCode: new Map([["AAA", "s"]]) },
    );
    expect(r.sku).toBeNull();
    expect(r.tier).toBe("unresolved");
  });

  it("unresolved: unknown style token", () => {
    const r = resolveFallbackSku({ itemNumber: "ZZZ-Blue-M", basePart: "ZZZ", color: "Blue", size: "M" }, ctx);
    expect(r).toEqual({ sku: null, tier: "unresolved" });
  });

  it("returns unresolved for a null row", () => {
    expect(resolveFallbackSku(null, ctx)).toEqual({ sku: null, tier: "unresolved" });
  });
});
