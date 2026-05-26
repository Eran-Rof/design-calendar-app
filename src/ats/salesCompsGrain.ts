// Grain classification + sibling discovery for Sales Comps.
//
// Sales Comps respects the ATS grid's "Explode PPK" toggle. The grid's
// canonical rule (per src/ats/compute.ts applyPpkMultiplierToRow + the
// CANONICAL grain memo) is: pack-grain iff master.style_code contains
// "PPK". When the toggle is ON, the grid multiplies pack-grain qty by
// master.pack_size to get eaches; when OFF, pack-grain qty stays in
// packs. Sales Comps mirrors that policy on its own aggregations, plus
// adds two structural rules the grid doesn't need:
//
//   * Explode ON: collapse PPK + each siblings into ONE row per
//     (style, color). Display key is the each-grain sibling (operator
//     reads in eaches).
//   * Explode OFF: split each dim row into two sub-rows when both
//     grains exist for that dim. Label rows with grain ("(PPK packs)"
//     vs "(each)") so the operator never sums packs and eaches into a
//     single misleading number.
//
// Sibling discovery mirrors api/_lib/sales-grain.js findSiblingPpkMaster
// — both directions (each → PPK and PPK → each), trying both naming
// conventions ("RBB1440N-PPK-BLACK" and "RYO0658PPK-BLACK"), plus the
// mis-tagged-style_code fallback for the RBB1438N family where the
// unit row carries style_code = "RBB1438N-PPK".

import type { ItemMasterRecord } from "./itemMasterLookup";

export type SkuGrain = "ppk" | "each";

/** Grid's canonical PPK gate (from compute.ts:42-69). pack-grain iff
 *  style_code contains "PPK" as a substring. style_code is the
 *  authoritative signal — size/sku tokens can be dirty. */
export function classifyMasterGrain(master: ItemMasterRecord | null): SkuGrain {
  if (!master) return "each";
  return /PPK/i.test(master.style_code ?? "") ? "ppk" : "each";
}

/** Style-color sibling key — used to collapse PPK + each siblings into
 *  one row when explodePpk is ON. Both grains of the same product share
 *  the same (style stem, color) pair; the PPK style_code is normalized
 *  to strip the "PPK" suffix so e.g. style "RYO0658PPK" + color "BLACK"
 *  pairs with style "RYO0658" + color "BLACK". Falls back to the raw
 *  sku_code when style_code or color is missing so unmatched rows still
 *  get a deterministic key (just one that never matches anything). */
export function siblingKeyFor(master: ItemMasterRecord | null): string {
  if (!master) return "(no master)";
  const style = (master.style_code ?? "").trim();
  const color = (master.color ?? "").trim();
  if (!style && !color) return master.sku_code || "(no master)";
  // Strip PPK + optional dash so both grains land on the same stem.
  // "RBB1440N-PPK" → "RBB1440N"
  // "RYO0658PPK"  → "RYO0658"
  // "RBB1438N-PPK" → "RBB1438N"
  const stem = style.replace(/-?PPK\d*$/i, "").toUpperCase();
  return `${stem}|${color.toUpperCase()}`;
}

/** Per-each pack-size for a master record. PPK-grain rows multiply
 *  their qty by this factor when explodePpk is ON. each-grain rows
 *  always return 1 (no multiplication). Defaults to 1 when pack_size
 *  is null/missing so we never accidentally multiply by 0/NaN. */
export function packSizeFor(master: ItemMasterRecord | null): number {
  if (!master) return 1;
  const ps = Number(master.pack_size);
  if (!Number.isFinite(ps) || ps <= 0) return 1;
  return Math.max(1, ps);
}

export type ResolveIdsFn = (sku: string) => string[];
export type GetMasterFn = (id: string) => ItemMasterRecord | null;

/** Resolve the first usable master for an ATS-grid sku string. Mirrors
 *  the lookup chain elsewhere in this module: resolveItemMasterIds →
 *  getItemMasterById, return the first record that's actually present
 *  in the cache. */
export function firstMasterFor(
  sku: string,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): ItemMasterRecord | null {
  for (const id of resolveIds(sku)) {
    const rec = getMaster(id);
    if (rec) return rec;
  }
  return null;
}

/** PPK → each sibling lookup. Given a PPK-grain master, find its
 *  each-grain sibling by trying both PPK naming conventions in reverse
 *  (strip the PPK token to produce each-grain candidates). Returns
 *  null when no each-grain master exists for the same (style stem,
 *  color) pair — common for prepacks that were never broken out as
 *  units in Xoro. */
export function findEachSibling(
  ppkMaster: ItemMasterRecord,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): ItemMasterRecord | null {
  if (!ppkMaster.sku_code) return null;
  // Candidate set: strip PPK<digits> wherever it appears in the
  // sku_code. We try both the dash form ("STYLE-PPK-COLOR" →
  // "STYLE-COLOR") and the glued form ("STYLEPPK-COLOR" →
  // "STYLE-COLOR"), plus the variant-pass shape with the trailing
  // size suffix ("STYLE-PPK48-COLOR" → "STYLE-COLOR").
  const sku = ppkMaster.sku_code;
  const candidates: string[] = [];
  // Glued form: "RYO0658PPK-BLACK" → "RYO0658-BLACK"
  candidates.push(sku.replace(/PPK\d*-/i, "-"));
  // Dash form: "RBB1440N-PPK-BLACK" → "RBB1440N-BLACK"
  candidates.push(sku.replace(/-PPK\d*-/i, "-"));
  // Trailing PPK<digits><color> form
  candidates.push(sku.replace(/-?PPK\d*(?=-|$)/i, ""));
  // Also strip via style+color from scratch when style_code carries the
  // PPK token directly. Some unit rows live at sku_code "STYLE-COLOR"
  // even when the style_code is "STYLEPPK".
  if (ppkMaster.style_code && ppkMaster.color) {
    const stem = ppkMaster.style_code.replace(/-?PPK\d*$/i, "");
    if (stem) candidates.push(`${stem}-${ppkMaster.color}`);
  }
  const seen = new Set<string>();
  for (const code of candidates) {
    if (!code || code === sku || seen.has(code)) continue;
    seen.add(code);
    for (const id of resolveIds(code)) {
      const rec = getMaster(id);
      if (rec && classifyMasterGrain(rec) === "each") return rec;
    }
  }
  return null;
}

/** each → PPK sibling lookup. Mirrors findSiblingPpkMaster from
 *  api/_lib/sales-grain.js — try the dash form, the glued form, and
 *  the mis-tagged-style_code fallback. Returns the first sibling whose
 *  master is PPK-grain, or null when no PPK sibling exists. */
export function findPpkSibling(
  eachMaster: ItemMasterRecord,
  resolveIds: ResolveIdsFn,
  getMaster: GetMasterFn,
): ItemMasterRecord | null {
  if (!eachMaster.style_code || !eachMaster.sku_code) return null;
  const variantSuffix = eachMaster.sku_code.slice(eachMaster.style_code.length);
  const candidates: string[] = [
    `${eachMaster.style_code}PPK${variantSuffix}`,
    `${eachMaster.style_code}-PPK${variantSuffix}`,
  ];
  // Mis-tagged-style_code fallback (see api/_lib/sales-grain.js comments):
  // the RBB1438N family has unit rows with style_code = "RBB1438N-PPK".
  // Strip the -PPK suffix to recover the true style stem and re-pair.
  const lastDash = eachMaster.sku_code.lastIndexOf("-");
  if (lastDash > 0) {
    const prefix = eachMaster.sku_code.slice(0, lastDash);
    const colorSuf = eachMaster.sku_code.slice(lastDash);
    const trueStyle = prefix.replace(/-?PPK\d*$/i, "");
    if (trueStyle && trueStyle !== eachMaster.style_code) {
      candidates.push(`${trueStyle}PPK${colorSuf}`);
      candidates.push(`${trueStyle}-PPK${colorSuf}`);
    }
  }
  const seen = new Set<string>();
  for (const code of candidates) {
    if (!code || code === eachMaster.sku_code || seen.has(code)) continue;
    seen.add(code);
    for (const id of resolveIds(code)) {
      const rec = getMaster(id);
      if (rec && classifyMasterGrain(rec) === "ppk") return rec;
    }
  }
  return null;
}

/** Multiplier applied to qty when explodePpk is ON. Returns the
 *  master.pack_size for PPK-grain masters; 1 for each-grain. Pure
 *  function — uses the classifier + pack-size helper above. */
export function explodeMultiplier(master: ItemMasterRecord | null): number {
  if (classifyMasterGrain(master) !== "ppk") return 1;
  return packSizeFor(master);
}

/** Display label suffix for the explode-OFF split. Renders "(PPK packs)"
 *  for PPK-grain rows and "(each)" for each-grain rows. Mixed dim rows
 *  use this to disambiguate which grain a sub-row represents so the
 *  operator never reads pack qty as eaches.
 *
 *  When explodePpk is ON, qty is uniformly in eaches (PPK × pack_size
 *  applied upstream) and the suffix is misleading — return "" so call
 *  sites don't append anything. Defensive guard: today the per-row
 *  label call sites only fire in the explode-OFF branch, but threading
 *  the flag here keeps the policy in one place. */
export function grainLabelSuffix(grain: SkuGrain, explodePpk: boolean = false): string {
  if (explodePpk) return "";
  return grain === "ppk" ? "(PPK packs)" : "(each)";
}
