// api/_lib/spineFallback.js
//
// Pure, side-effect-free FALLBACK resolution for the spine on-hand sync
// (scripts/sync-onhand-spine.mjs). A Xoro-REST feed row that ties neither via
// the UPC spine (upc_item_master) nor the private-label ItemNumber path was, up
// to now, SKIPPED — so its layers were never trued and its tangerine_size_onhand
// row never written, freezing both sides against the live feed (the 2026-07-22
// $33k accuracy exposure: lowercase / mixed-case / inseam-embedded BasePartNumbers
// like `RYB186230` = RYB1862 + inseam 30 all fell through UPC-only resolution).
//
// This module GENERALISES the resolution beyond private-label with two ordered,
// NEVER-GUESS tiers, imported by the script:
//   Tier A  normcode      — the feed ItemNumber, normalised (UPPER + strip every
//                           non-alphanumeric), hits EXACTLY ONE catalog sku_code
//                           (ambiguous norm → skip). Generalises the PL normSku
//                           path to the whole catalog.
//   Tier B  inseam-tuple  — peel the trailing 2-digit inseam off the
//                           BasePartNumber, resolve the parent style
//                           (resolveStyleToken), then pick the EXACTLY-ONE
//                           (colour, size, inseam) catalog row (pickColorSizeMatch,
//                           which tolerates Xoro↔catalog spelling: Gray↔Grey,
//                           Lt↔Light, S↔SMALL, …). Zero or multiple → skip.
//
// Extracted here so the tiers are unit-testable WITHOUT a DB round-trip. The
// script imports these — keep it the single source of truth, do NOT fork copies.
// resolveStyleToken / pickColorSizeMatch live in xoroLineMatch.js (#1874); this
// module only imports them.

import { resolveStyleToken, pickColorSizeMatch } from "./xoroLineMatch.js";

// Normalised catalog/feed code key: UPPER, strip every non-alphanumeric. Mirrors
// the script's private-label normSku so lowercase / mixed-case / punctuation
// variants of the same code collapse together.
export const normSkuCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Build a normalised-sku-code → item_id index that keeps ONLY unambiguous keys:
// a norm shared by two DIFFERENT item_ids is dropped (never guess which SKU a
// feed row means). Duplicate rows for the SAME item_id are fine.
//   items — [{ id, sku_code }, …] (any extra fields ignored)
export function buildNormSkuIndex(items) {
  const byNorm = new Map(); // norm -> item_id | null(=ambiguous)
  for (const it of items || []) {
    if (!it || !it.id || !it.sku_code) continue;
    const k = normSkuCode(it.sku_code);
    if (!k) continue;
    if (!byNorm.has(k)) byNorm.set(k, it.id);
    else if (byNorm.get(k) !== it.id) byNorm.set(k, null); // collision → ambiguous
  }
  const out = new Map();
  for (const [k, v] of byNorm) if (v) out.set(k, v);
  return out;
}

// Group catalog rows by style_id for the inseam-tuple tier's candidate pool.
//   items — [{ id, style_id, color, size, inseam }, …]
// Returns Map<style_id, [{ id, color, size, inseam }]>.
export function buildStyleRowIndex(items) {
  const m = new Map();
  for (const it of items || []) {
    if (!it || !it.id || it.style_id == null) continue;
    let arr = m.get(it.style_id);
    if (!arr) { arr = []; m.set(it.style_id, arr); }
    arr.push({ id: it.id, color: it.color, size: it.size, inseam: it.inseam });
  }
  return m;
}

// Resolve a UPC-miss feed row to a catalog item_id, or null (unresolved).
//   row — { itemNumber, basePart, color, size } (raw Xoro REST columns)
//   ctx — { normIndex, styleByCode, rowsByStyle } (from the builders above +
//          the importer's style_master map)
// Returns { sku, tier } — tier ∈ 'normcode' | 'inseam' | 'unresolved'. `inseam`
// covers BOTH the plain (no inseam peeled) and inseam-composite tuple hits; the
// distinguishing detail is logged by the caller, not needed downstream.
export function resolveFallbackSku(row, { normIndex, styleByCode, rowsByStyle } = {}) {
  if (!row) return { sku: null, tier: "unresolved" };
  // Tier A — normalised ItemNumber → unique catalog sku_code.
  const nk = normSkuCode(row.itemNumber);
  if (nk && normIndex) {
    const hit = normIndex.get(nk);
    if (hit) return { sku: hit, tier: "normcode" };
  }
  // Tier B — inseam-aware style token + exactly-one (colour, size, inseam) tuple.
  if (styleByCode && rowsByStyle) {
    const { styleId, inseam } = resolveStyleToken(styleByCode, row.basePart);
    if (styleId) {
      const hit = pickColorSizeMatch(rowsByStyle.get(styleId) || [], { color: row.color, size: row.size, inseam });
      if (hit) return { sku: hit.id, tier: "inseam" };
    }
  }
  return { sku: null, tier: "unresolved" };
}
