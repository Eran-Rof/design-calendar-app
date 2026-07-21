// api/_lib/layerCost.js — tiered unit-cost resolution for on-hand layer writes.
//
// Xoro's item costing (mirrored into ip_item_avg_cost, keyed by sku_code) keys
// inseam-program styles by the INSEAM-EMBEDDED BasePartNumber ("RYB059430-…"),
// while Tangerine per-size SKUs are coded "RYB0594-COLOR-SIZE(-INSEAM)". A
// naive exact-code lookup therefore reads $0 for whole denim programs — the
// 2026-07-21 backfill found 158k units at $0 that all had real Xoro costs.
// This resolver mirrors that backfill's tiers so nightly layer CREATEs can
// never re-accrete zero-cost stock:
//   T1  exact sku_code match
//   T2  color-level code (sku_code minus its trailing -token)
//   T3  inseam-stem average: mean avg_cost over "<style_code><inseam>-%" keys
//   T4  style-prefix average: mean over "<style_code>%" keys
//   →0  only when the costing mirror truly has nothing for the style.
//
// makeCostResolver(avgCostByCode) → (meta) => cents
//   avgCostByCode : Map<sku_code, avg_cost DOLLARS> (as loaded by the spine)
//   meta          : { skuCode, styleCode, inseam } (any may be null)
// Stem averages are memoized per resolver instance — the avg-cost map is
// scanned at most once per distinct stem, not per SKU.

export function makeCostResolver(avgCostByCode) {
  const stemCache = new Map(); // stem key -> cents|0

  // Mean avg_cost (in cents) over map entries whose key starts with `prefix`
  // and, when `dashAfter` is set, is followed by "-". 0 when none match.
  function prefixAvgCents(prefix, dashAfter) {
    const key = `${dashAfter ? "d:" : "p:"}${prefix}`;
    if (stemCache.has(key)) return stemCache.get(key);
    let sum = 0, n = 0;
    for (const [code, dollars] of avgCostByCode) {
      if (!(dollars > 0)) continue;
      if (!code.startsWith(prefix)) continue;
      if (dashAfter && code[prefix.length] !== "-") continue;
      sum += dollars; n++;
    }
    const cents = n ? Math.round((sum / n) * 100) : 0;
    stemCache.set(key, cents);
    return cents;
  }

  return function resolveUnitCostCents(meta) {
    const skuCode = meta?.skuCode || null;
    const styleCode = meta?.styleCode ? String(meta.styleCode).trim() : null;
    const inseam = meta?.inseam != null && String(meta.inseam).trim() !== "" ? String(meta.inseam).trim() : null;

    // T1: exact sku_code.
    if (skuCode) {
      const d = avgCostByCode.get(skuCode);
      if (d > 0) return Math.round(d * 100);
      // T2: color-level code (strip the trailing -token, e.g. size).
      const colorCode = skuCode.replace(/-[^-]+$/, "");
      if (colorCode && colorCode !== skuCode) {
        const c = avgCostByCode.get(colorCode);
        if (c > 0) return Math.round(c * 100);
      }
    }
    if (!styleCode) return 0;
    // T3: inseam-embedded BP stem ("RYB0594" + "30" → RYB059430-…).
    if (inseam) {
      const cents = prefixAvgCents(styleCode + inseam, true);
      if (cents > 0) return cents;
    }
    // T4: any costing row under the style prefix.
    return prefixAvgCents(styleCode, false);
  };
}
